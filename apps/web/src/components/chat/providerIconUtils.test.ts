import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KimiIcon, MuseCodeIcon, PiAgentIcon } from "../Icons";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("provider icons", () => {
  it("maps Kimi to its bundled vector icon", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("kimi")]).toBe(KimiIcon);
    expect(renderToStaticMarkup(createElement(KimiIcon))).toContain("<path");
  });

  it("renders the Muse Code glyph instead of the initials fallback", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("museCode")]).toBe(MuseCodeIcon);
  });

  it("maps Pi to its bundled agent icon", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("pi")]).toBe(PiAgentIcon);
  });

  it("renders the labeled Pi vector mark without a text or initials badge", () => {
    const icon = renderToStaticMarkup(createElement(PiAgentIcon));
    expect(icon).toContain('role="img"');
    expect(icon).toContain('aria-label="Pi"');
    expect(icon).toContain("<path");
    expect(icon).not.toContain("<text");

    const instance = renderToStaticMarkup(
      createElement(ProviderInstanceIcon, {
        driverKind: ProviderDriverKind.make("pi"),
        displayName: "Pi",
        accentColor: "#7652d8",
        showBadge: true,
      }),
    );
    expect(instance).toContain("<svg");
    expect(instance).not.toContain(">PI<");
  });
});
