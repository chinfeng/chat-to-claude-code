/** Streaming parser for provider-emitted thinking tags. */

export enum ContentType {
  TEXT = "text",
  THINKING = "thinking",
}

export class ContentChunk {
  constructor(
    public readonly type: ContentType,
    public readonly content: string,
  ) {}
}

export class ThinkTagParser {
  static readonly OPEN_TAG = "<think>";
  static readonly CLOSE_TAG = "</think>";

  private _buffer = "";
  private _inThinkTag = false;

  get inThinkMode(): boolean {
    return this._inThinkTag;
  }

  *feed(content: string): Generator<ContentChunk> {
    this._buffer += content;

    while (this._buffer) {
      const prevLen = this._buffer.length;
      let chunk: ContentChunk | null;

      if (!this._inThinkTag) {
        chunk = this._parseOutsideThink();
      } else {
        chunk = this._parseInsideThink();
      }

      if (chunk) {
        yield chunk;
      } else if (this._buffer.length === prevLen) {
        break;
      }
    }
  }

  private _parseOutsideThink(): ContentChunk | null {
    const OPEN = ThinkTagParser.OPEN_TAG;
    const CLOSE = ThinkTagParser.CLOSE_TAG;
    const thinkStart = this._buffer.indexOf(OPEN);
    const orphanClose = this._buffer.indexOf(CLOSE);

    if (orphanClose !== -1 && (thinkStart === -1 || orphanClose < thinkStart)) {
      const preOrphan = this._buffer.slice(0, orphanClose);
      this._buffer = this._buffer.slice(orphanClose + CLOSE.length);
      if (preOrphan) return new ContentChunk(ContentType.TEXT, preOrphan);
      return null;
    }

    if (thinkStart === -1) {
      const lastBracket = this._buffer.lastIndexOf("<");
      if (lastBracket !== -1) {
        const potentialTag = this._buffer.slice(lastBracket);
        const tagLen = potentialTag.length;
        if (
          (tagLen < OPEN.length && OPEN.startsWith(potentialTag)) ||
          (tagLen < CLOSE.length && CLOSE.startsWith(potentialTag))
        ) {
          const emit = this._buffer.slice(0, lastBracket);
          this._buffer = this._buffer.slice(lastBracket);
          if (emit) return new ContentChunk(ContentType.TEXT, emit);
          return null;
        }
      }

      const emit = this._buffer;
      this._buffer = "";
      if (emit) return new ContentChunk(ContentType.TEXT, emit);
      return null;
    }

    const preThink = this._buffer.slice(0, thinkStart);
    this._buffer = this._buffer.slice(thinkStart + OPEN.length);
    this._inThinkTag = true;
    if (preThink) return new ContentChunk(ContentType.TEXT, preThink);
    return null;
  }

  private _parseInsideThink(): ContentChunk | null {
    const CLOSE = ThinkTagParser.CLOSE_TAG;
    const thinkEnd = this._buffer.indexOf(CLOSE);

    if (thinkEnd === -1) {
      const lastBracket = this._buffer.lastIndexOf("<");
      if (
        lastBracket !== -1 &&
        this._buffer.length - lastBracket < CLOSE.length
      ) {
        const potentialTag = this._buffer.slice(lastBracket);
        if (CLOSE.startsWith(potentialTag)) {
          const emit = this._buffer.slice(0, lastBracket);
          this._buffer = this._buffer.slice(lastBracket);
          if (emit) return new ContentChunk(ContentType.THINKING, emit);
          return null;
        }
      }

      const emit = this._buffer;
      this._buffer = "";
      if (emit) return new ContentChunk(ContentType.THINKING, emit);
      return null;
    }

    const thinkingContent = this._buffer.slice(0, thinkEnd);
    this._buffer = this._buffer.slice(thinkEnd + CLOSE.length);
    this._inThinkTag = false;
    if (thinkingContent)
      return new ContentChunk(ContentType.THINKING, thinkingContent);
    return null;
  }

  flush(): ContentChunk | null {
    if (this._buffer) {
      const chunkType = this._inThinkTag ? ContentType.THINKING : ContentType.TEXT;
      const content = this._buffer;
      this._buffer = "";
      return new ContentChunk(chunkType, content);
    }
    return null;
  }
}
