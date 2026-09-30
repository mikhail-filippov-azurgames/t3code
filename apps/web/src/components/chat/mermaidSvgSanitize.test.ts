import { describe, expect, it } from "vite-plus/test";

import { sanitizeMermaidSvg } from "./mermaidSvgSanitize";

describe("sanitizeMermaidSvg", () => {
  it("drops script elements together with their content", () => {
    expect(sanitizeMermaidSvg('<svg><script>alert(1)</script><g id="ok"/></svg>')).toBe(
      '<svg><g id="ok"/></svg>',
    );
    expect(sanitizeMermaidSvg('<svg><script src="http://evil/x.js"></script></svg>')).toBe(
      "<svg></svg>",
    );
  });

  it("drops foreignObject HTML islands with their content", () => {
    expect(
      sanitizeMermaidSvg(
        '<svg><foreignObject width="10" height="10"><img src="x" onerror="alert(1)"></foreignObject><text>label</text></svg>',
      ),
    ).toBe("<svg><text>label</text></svg>");
    expect(
      sanitizeMermaidSvg(
        '<svg><foreignObject><p onclick="alert(1)">styled</p></foreignObject></svg>',
      ),
    ).toBe("<svg></svg>");
  });

  it("drops event handler attributes from any element", () => {
    expect(
      sanitizeMermaidSvg(
        '<svg><g onclick="alert(1)" onload="alert(2)" data-onkeep="y"><text>x</text></g></svg>',
      ),
    ).toBe('<svg><g data-onkeep="y"><text>x</text></g></svg>');
    expect(sanitizeMermaidSvg('<svg><text onmouseover="alert(1)">t</text></svg>')).toBe(
      "<svg><text>t</text></svg>",
    );
  });

  it("drops link elements that load external resources", () => {
    expect(
      sanitizeMermaidSvg('<svg><link rel="stylesheet" href="http://evil/a.css"/><g/></svg>'),
    ).toBe("<svg><g/></svg>");
    expect(sanitizeMermaidSvg('<svg><link rel="prefetch" href="http://evil"></svg>')).toBe(
      "<svg></svg>",
    );
  });

  it("drops script-capable embed and animation elements", () => {
    expect(sanitizeMermaidSvg('<svg><embed src="http://evil"/><rect/></svg>')).toBe(
      "<svg><rect/></svg>",
    );
    expect(
      sanitizeMermaidSvg('<svg><set attributeName="href" to="javascript:alert(1)"/><rect/></svg>'),
    ).toBe("<svg><rect/></svg>");
  });

  it("neutralizes script protocols in href and xlink:href", () => {
    expect(sanitizeMermaidSvg('<svg><a href="javascript:alert(1)"><text>x</text></a></svg>')).toBe(
      "<svg><a><text>x</text></a></svg>",
    );
    expect(
      sanitizeMermaidSvg('<svg><a xlink:href="JavaScript:alert(1)"><text>x</text></a></svg>'),
    ).toBe("<svg><a><text>x</text></a></svg>");
    expect(sanitizeMermaidSvg('<svg><image xlink:href="data:image/svg+xml,ss"/></svg>')).toBe(
      "<svg><image/></svg>",
    );
    expect(
      sanitizeMermaidSvg('<svg><a href="&#106;avascript:alert(1)"><text>x</text></a></svg>'),
    ).toBe("<svg><a><text>x</text></a></svg>");
    expect(
      sanitizeMermaidSvg('<svg><a href="java&#9;script:alert(1)"><text>x</text></a></svg>'),
    ).toBe("<svg><a><text>x</text></a></svg>");
  });

  it("keeps fragment, relative, and http links", () => {
    expect(sanitizeMermaidSvg('<svg><a href="#node"><text>x</text></a></svg>')).toBe(
      '<svg><a href="#node"><text>x</text></a></svg>',
    );
    expect(sanitizeMermaidSvg('<svg><image href="https://example.test/a.png"/></svg>')).toBe(
      '<svg><image href="https://example.test/a.png"/></svg>',
    );
  });

  it("keeps diagram structure and stylesheet theming", () => {
    const safe =
      '<svg><style>.node{fill:#fff}</style><g id="a"><text>A</text></g><path d="M0 0"/></svg>';
    expect(sanitizeMermaidSvg(safe)).toBe(safe);
  });

  it("strips CSS-borne script vectors without dropping diagram styles", () => {
    expect(
      sanitizeMermaidSvg(
        '<svg><style>@import url("http://evil");.n{fill:red;background:url(javascript:alert(1))}</style></svg>',
      ),
    ).toBe("<svg><style>.n{fill:red;background:url(blocked:alert(1))}</style></svg>");
  });

  it("leaves empty and already-safe svg untouched", () => {
    expect(sanitizeMermaidSvg("")).toBe("");
    expect(sanitizeMermaidSvg("<svg/>")).toBe("<svg/>");
  });
});
