import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { MuseCodeIcon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("provider icons", () => {
  it("renders the Muse Code glyph instead of the initials fallback", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("museCode")]).toBe(MuseCodeIcon);
  });
});
