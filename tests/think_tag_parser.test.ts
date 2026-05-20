import { describe, it, expect } from "bun:test";
import { ThinkTagParser, ContentType } from "../src/parsers/think_tag_parser.js";

const OPEN = ThinkTagParser.OPEN_TAG;
const CLOSE = ThinkTagParser.CLOSE_TAG;

describe("ThinkTagParser", () => {
  it("yields TEXT content when no think tags", () => {
    const parser = new ThinkTagParser();
    const chunks = [...parser.feed("Hello world")];
    expect(chunks).toEqual([{ type: ContentType.TEXT, content: "Hello world" }]);
  });

  it("yields THINKING content inside think tags", () => {
    const parser = new ThinkTagParser();
    const chunks = [...parser.feed(`${OPEN}my thoughts${CLOSE}answer`)];
    const thinking = chunks.filter((c) => c.type === ContentType.THINKING);
    const text = chunks.filter((c) => c.type === ContentType.TEXT);
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking.map((c) => c.content).join("")).toContain("my thoughts");
    expect(text.length).toBeGreaterThan(0);
    expect(text.map((c) => c.content).join("")).toContain("answer");
  });

  it("handles streaming across tag boundaries", () => {
    const parser = new ThinkTagParser();
    const results: Array<{ type: ContentType; content: string }> = [];

    for (const part of parser.feed(`${OPEN}thinking`)) {
      results.push(part);
    }
    for (const part of parser.feed(` more${CLOSE}text`)) {
      results.push(part);
    }

    const allContent = results.map((c) => c.content).join("");
    expect(allContent).toContain("thinking");
    expect(allContent).toContain("more");
    expect(allContent).toContain("text");
  });

  it("handles empty feed", () => {
    const parser = new ThinkTagParser();
    const chunks = [...parser.feed("")];
    expect(chunks).toEqual([]);
  });

  it("flush returns remaining buffer as THINKING when inside tag", () => {
    const parser = new ThinkTagParser();
    // Feed content that ends with a partial close tag — buffer stays inside think mode
    [...parser.feed(`${OPEN}partial${CLOSE.slice(0, -1)}`)];
    const remaining = parser.flush();
    expect(remaining).not.toBeNull();
    expect(remaining!.type).toBe(ContentType.THINKING);
  });

  it("flush returns remaining buffer as TEXT when outside tag", () => {
    const parser = new ThinkTagParser();
    // Feed partial open tag at end — text before it stays in buffer
    [...parser.feed("before " + OPEN.slice(0, 3))];
    const remaining = parser.flush();
    expect(remaining).not.toBeNull();
    expect(remaining!.type).toBe(ContentType.TEXT);
  });

  it("handles orphan close tag", () => {
    const parser = new ThinkTagParser();
    const chunks = [...parser.feed(`before${CLOSE}after`)];
    const allContent = chunks.map((c) => c.content).join("");
    expect(allContent).toContain("before");
    expect(allContent).toContain("after");
  });

  it("handles partial open tag at buffer end", () => {
    const parser = new ThinkTagParser();
    const partial = OPEN.slice(0, -1);
    const chunks1 = [...parser.feed(`hello ${partial}`)];
    const chunks2 = [...parser.feed(`${OPEN.slice(-1)}thinking${CLOSE}text`)];
    const allText = [...chunks1, ...chunks2].map((c) => c.content).join("");
    expect(allText).toContain("hello");
    expect(allText).toContain("thinking");
    expect(allText).toContain("text");
  });

  it("returns null flush when buffer is empty", () => {
    const parser = new ThinkTagParser();
    expect(parser.flush()).toBeNull();
  });
});
