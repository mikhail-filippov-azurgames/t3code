import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

function htmlOf(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { urlTransform: (href: string) => href } as never, markdown),
  );
}

describe("probe", () => {
  it("backslash", () => {
    expect({
      bs1: htmlOf(String.raw`[Open](C:\Users\shawn\project\src\main.ts)`),
      bs2: htmlOf(
        String.raw`[plan](C:\Users\User\.opencontext\contexts\kick-the-buddy\x\chn-02.md)`,
      ),
      fw: htmlOf("[Open](C:/Users/shawn/project/src/main.ts)"),
      ref: htmlOf("[Open][source]\n\n[source]: C:/Users/shawn/project/src/main.ts"),
      dot: htmlOf(String.raw`[plan](C:\Users\User\.opencontext\notes.md)`),
      esc: htmlOf(String.raw`[plan](C:\Users\User\src\main.ts)`),
    }).toEqual({});
  });
});
