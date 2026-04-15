import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execSync: vi.fn(),
	spawn: vi.fn(),
	platform: vi.fn(() => "darwin" as NodeJS.Platform),
	isWaylandSession: vi.fn(() => false),
	clipboard: { setText: vi.fn<(text: string) => Promise<void>>() },
}));

vi.mock("child_process", () => ({ execSync: mocks.execSync, spawn: mocks.spawn }));
vi.mock("os", () => ({ platform: mocks.platform }));
vi.mock("../src/utils/clipboard-image.js", () => ({ isWaylandSession: mocks.isWaylandSession }));
vi.mock("../src/utils/clipboard-native.js", () => ({ clipboard: mocks.clipboard }));

import { copyToClipboard } from "../src/utils/clipboard.js";

describe("copyToClipboard", () => {
	const stdoutWrite = vi.spyOn(process.stdout, "write");
	const savedEnv = { ...process.env };

	beforeEach(() => {
		vi.resetAllMocks();
		mocks.platform.mockReturnValue("darwin");
		stdoutWrite.mockReturnValue(true);
		process.env = { ...savedEnv };
	});

	afterEach(() => {
		stdoutWrite.mockRestore();
		process.env = savedEnv;
	});

	test("emits OSC 52 with base64-encoded text", async () => {
		await copyToClipboard("test");

		const osc52 = stdoutWrite.mock.calls[0]![0] as string;
		expect(osc52).toContain("\x1b]52;c;");
		expect(osc52).toContain(Buffer.from("test").toString("base64"));
	});

	test("uses native addon as primary path", async () => {
		await copyToClipboard("hello");

		expect(mocks.clipboard.setText).toHaveBeenCalledWith("hello");
		expect(mocks.execSync).not.toHaveBeenCalled();
	});

	test("serializes native clipboard writes", async () => {
		let resolveFirstWrite: (() => void) | undefined;
		const firstWriteDone = new Promise<void>((resolve) => {
			resolveFirstWrite = resolve;
		});
		let callCount = 0;
		mocks.clipboard.setText.mockImplementation(async () => {
			callCount += 1;
			if (callCount === 1) {
				await firstWriteDone;
			}
		});

		const firstCopy = copyToClipboard("first");
		const secondCopy = copyToClipboard("second");

		await Promise.resolve();
		expect(mocks.clipboard.setText).toHaveBeenCalledTimes(1);
		expect(mocks.clipboard.setText).toHaveBeenNthCalledWith(1, "first");

		resolveFirstWrite?.();
		await firstCopy;
		await secondCopy;

		expect(mocks.clipboard.setText).toHaveBeenCalledTimes(2);
		expect(mocks.clipboard.setText).toHaveBeenNthCalledWith(2, "second");
	});

	describe("fallback when native addon fails", () => {
		beforeEach(() => {
			mocks.clipboard.setText.mockRejectedValue(new Error("unavailable"));
		});

		test("macOS: uses pbcopy", async () => {
			await copyToClipboard("hello");
			expect(mocks.execSync).toHaveBeenCalledWith("pbcopy", expect.objectContaining({ input: "hello" }));
		});

		test("windows: uses clip", async () => {
			mocks.platform.mockReturnValue("win32");
			await copyToClipboard("hello");
			expect(mocks.execSync).toHaveBeenCalledWith("clip", expect.objectContaining({ input: "hello" }));
		});

		test("linux X11: uses xclip", async () => {
			mocks.platform.mockReturnValue("linux");
			process.env.DISPLAY = ":0";
			delete process.env.WAYLAND_DISPLAY;

			await copyToClipboard("hello");

			expect(mocks.execSync).toHaveBeenCalledWith(
				"xclip -selection clipboard",
				expect.objectContaining({ input: "hello" }),
			);
		});

		test("linux X11: falls back to xsel when xclip missing", async () => {
			mocks.platform.mockReturnValue("linux");
			process.env.DISPLAY = ":0";
			delete process.env.WAYLAND_DISPLAY;
			mocks.execSync.mockImplementation((cmd: string) => {
				if (cmd === "xclip -selection clipboard") throw new Error("not found");
			});

			await copyToClipboard("hello");

			expect(mocks.execSync).toHaveBeenCalledWith(
				"xsel --clipboard --input",
				expect.objectContaining({ input: "hello" }),
			);
		});

		test("linux Wayland: uses wl-copy via spawn", async () => {
			mocks.platform.mockReturnValue("linux");
			mocks.isWaylandSession.mockReturnValue(true);
			process.env.WAYLAND_DISPLAY = "wayland-0";
			delete process.env.DISPLAY;
			const fakeStdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
			mocks.spawn.mockReturnValue({ stdin: fakeStdin, unref: vi.fn() });

			await copyToClipboard("hello");

			expect(mocks.spawn).toHaveBeenCalledWith("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
			expect(fakeStdin.write).toHaveBeenCalledWith("hello");
		});
	});
});
