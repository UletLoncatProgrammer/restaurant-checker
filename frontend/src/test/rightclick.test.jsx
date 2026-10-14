import { describe, it, expect, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderAs, USERS } from "./utils.jsx";

vi.mock("../lib/socket", () => ({ getSocket: () => ({ on() {}, off() {} }), closeSocket() {} }));
vi.mock("../lib/api", () => ({
  getToken: () => "t",
  api: { getOpenOrders: vi.fn().mockResolvedValue([]), getCategories: vi.fn().mockResolvedValue([]), getTables: vi.fn().mockResolvedValue([]) },
}));

import App from "../App.jsx";

describe("right click", () => {
  it("context menu and dragging are blocked app-wide", async () => {
    renderAs(USERS.FOH, <App />, "/order-entry");
    const ctx = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    const drag = new Event("dragstart", { bubbles: true, cancelable: true });
    await act(async () => {
      document.body.dispatchEvent(ctx);
      document.body.dispatchEvent(drag);
    });
    expect(ctx.defaultPrevented).toBe(true);
    expect(drag.defaultPrevented).toBe(true);
  });
});
