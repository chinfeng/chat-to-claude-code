/** Heuristic parser for text-emitted tool calls. */

import { randomUUID } from "crypto";

const CONTROL_TOKEN_RE = /<\|[^|>]{1,80}\|>/g;
const CONTROL_TOKEN_START = "<|";
const CONTROL_TOKEN_END = "|>";

enum ParserState {
  TEXT = 1,
  MATCHING_FUNCTION = 2,
  PARSING_PARAMETERS = 3,
}

const FUNC_START_PATTERN = /●\s*<function=([^>]+)>/;
const PARAM_PATTERN = /<parameter=([^>]+)>([\s\S]*?)(?:<\/parameter>|$)/g;
const WEB_TOOL_JSON_PATTERN =
  /\b(?:use\s+)?(?<tool>WebFetch|WebSearch)\b.*?(?<json>\{.*?\})/gis;

export class HeuristicToolParser {
  private _state = ParserState.TEXT;
  private _buffer = "";
  private _currentToolId: string | null = null;
  private _currentFunctionName: string | null = null;
  private _currentParameters: Record<string, string> = {};

  private _extractWebToolJsonCalls(): {
    filteredBuffer: string;
    detectedTools: Record<string, unknown>[];
  } {
    const detectedTools: Record<string, unknown>[] = [];
    // Reset regex state
    const pattern = new RegExp(WEB_TOOL_JSON_PATTERN.source, "gis");
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(this._buffer)) !== null) {
      try {
        const toolInput = JSON.parse(match.groups!.json);
        if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput))
          continue;
        const toolName = match.groups!.tool;
        if (toolName === "WebFetch" && !("url" in toolInput)) continue;
        if (toolName === "WebSearch" && !("query" in toolInput)) continue;
        detectedTools.push({
          type: "tool_use",
          id: `toolu_heuristic_${randomUUID().slice(0, 8)}`,
          name: toolName,
          input: toolInput,
        });
      } catch {
        continue;
      }
    }

    if (!detectedTools.length) return { filteredBuffer: this._buffer, detectedTools: [] };
    return { filteredBuffer: "", detectedTools };
  }

  private _stripControlTokens(text: string): string {
    return text.replace(CONTROL_TOKEN_RE, "");
  }

  private _splitIncompleteControlTokenTail(): string {
    const start = this._buffer.lastIndexOf(CONTROL_TOKEN_START);
    if (start === -1) return "";
    const end = this._buffer.indexOf(CONTROL_TOKEN_END, start);
    if (end !== -1) return "";
    const prefix = this._buffer.slice(0, start);
    this._buffer = this._buffer.slice(start);
    return prefix;
  }

  feed(text: string): [string, Record<string, unknown>[]] {
    this._buffer += text;
    this._buffer = this._stripControlTokens(this._buffer);

    const { filteredBuffer, detectedTools } = this._extractWebToolJsonCalls();
    this._buffer = filteredBuffer;

    const filteredOutputParts: string[] = [];

    while (true) {
      if (this._state === ParserState.TEXT) {
        if (this._buffer.includes("●")) {
          const idx = this._buffer.indexOf("●");
          filteredOutputParts.push(this._buffer.slice(0, idx));
          this._buffer = this._buffer.slice(idx);
          this._state = ParserState.MATCHING_FUNCTION;
        } else {
          const safePrefix = this._splitIncompleteControlTokenTail();
          if (safePrefix) filteredOutputParts.push(safePrefix);
          break;
        }
      }

      if (this._state === ParserState.MATCHING_FUNCTION) {
        const match = FUNC_START_PATTERN.exec(this._buffer);
        if (match) {
          this._currentFunctionName = match[1].trim();
          this._currentToolId = `toolu_heuristic_${randomUUID().slice(0, 8)}`;
          this._currentParameters = {};
          this._buffer = this._buffer.slice(match.index + match[0].length);
          this._state = ParserState.PARSING_PARAMETERS;
        } else if (this._buffer.length > 100) {
          filteredOutputParts.push(this._buffer[0]);
          this._buffer = this._buffer.slice(1);
          this._state = ParserState.TEXT;
        } else {
          break;
        }
      }

      if (this._state === ParserState.PARSING_PARAMETERS) {
        let finishedToolCall = false;

        while (true) {
          const paramPattern = new RegExp(PARAM_PATTERN.source, "gs");
          const paramMatch = paramPattern.exec(this._buffer);
          if (paramMatch && paramMatch[0].includes("</parameter>")) {
            const preMatchText = this._buffer.slice(0, paramMatch.index);
            if (preMatchText) filteredOutputParts.push(preMatchText);
            const key = paramMatch[1].trim();
            const val = paramMatch[2].trim();
            this._currentParameters[key] = val;
            this._buffer = this._buffer.slice(paramMatch.index + paramMatch[0].length);
          } else {
            break;
          }
        }

        if (this._buffer.includes("●")) {
          const idx = this._buffer.indexOf("●");
          if (idx > 0) filteredOutputParts.push(this._buffer.slice(0, idx));
          this._buffer = this._buffer.slice(idx);
          finishedToolCall = true;
        } else if (
          this._buffer.length > 0 &&
          !this._buffer.trim().startsWith("<")
        ) {
          if (!this._buffer.includes("<parameter=")) {
            filteredOutputParts.push(this._buffer);
            this._buffer = "";
            finishedToolCall = true;
          }
        }

        if (finishedToolCall && this._currentToolId && this._currentFunctionName) {
          detectedTools.push({
            type: "tool_use",
            id: this._currentToolId,
            name: this._currentFunctionName,
            input: this._currentParameters,
          });
          this._state = ParserState.TEXT;
        } else {
          break;
        }
      }
    }

    return [filteredOutputParts.join(""), detectedTools];
  }

  flush(): { text: string; tools: Record<string, unknown>[] } {
    this._buffer = this._stripControlTokens(this._buffer);
    const detectedTools: Record<string, unknown>[] = [];
    let remainingText = "";

    if (this._state === ParserState.PARSING_PARAMETERS && this._currentToolId && this._currentFunctionName) {
      const partialMatches = this._buffer.matchAll(/<parameter=([^>]+)>([\s\S]*)$/g);
      for (const match of partialMatches) {
        const key = match[1].trim();
        const val = match[2].trim();
        this._currentParameters[key] = val;
      }
      detectedTools.push({
        type: "tool_use",
        id: this._currentToolId,
        name: this._currentFunctionName,
        input: this._currentParameters,
      });
      this._state = ParserState.TEXT;
    } else if (this._state === ParserState.MATCHING_FUNCTION) {
      // Incomplete function header — emit as text
      remainingText = this._buffer;
    } else if (this._state === ParserState.TEXT && this._buffer) {
      remainingText = this._buffer;
    }

    this._buffer = "";
    return { text: remainingText, tools: detectedTools };
  }
}