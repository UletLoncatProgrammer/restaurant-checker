import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// jsdom has no audio playback or object URLs; stub the bits the app touches.
if (!URL.createObjectURL) URL.createObjectURL = () => "blob:test";
