import assert from "node:assert/strict";
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";

import { Logger, isJournalStream } from "../src/log";

describe("Logger", () => {
    afterEach(() => {
        mock.restoreAll();
        Logger.silent = true;
        Logger.debugEnabled = false;
        Logger.journalPriorities = false;
    });

    function capture(): { out: string[]; err: string[] } {
        const lines = { out: [] as string[], err: [] as string[] };
        mock.method(console, "log", (line: unknown) => lines.out.push(String(line)));
        mock.method(console, "warn", (line: unknown) => lines.err.push(String(line)));
        mock.method(console, "error", (line: unknown) => lines.err.push(String(line)));
        Logger.silent = false;
        return lines;
    }

    it("writes time, level and scope; debug only when enabled", () => {
        const lines = capture();
        const log = new Logger("bridge").child("Kitchen");
        log.debug("hidden");
        Logger.debugEnabled = true;
        log.debug("details");
        log.info("stop");
        assert.equal(lines.out.length, 2);
        assert.match(lines.out[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z DEBUG \[bridge\/Kitchen\] details$/);
        assert.match(lines.out[1], /Z INFO \[bridge\/Kitchen\] stop$/);
    });

    it("marks warnings and errors with their priority for the systemd journal", () => {
        const lines = capture();
        const log = new Logger("main");
        log.warn("plain");
        Logger.journalPriorities = true;
        Logger.debugEnabled = true;
        log.warn("box not reachable");
        log.error("crashed");
        log.info("info keeps the default priority");
        log.debug("debug too");
        assert.match(lines.err[0], /^\d{4}-.*WARN \[main\] plain$/);
        assert.match(lines.err[1], /^<4>\d{4}-.*WARN \[main\] box not reachable$/);
        assert.match(lines.err[2], /^<3>\d{4}-.*ERROR \[main\] crashed$/);
        assert.ok(lines.out.every((line) => /^\d{4}-/.test(line)), "no prefix for info and debug");
    });

    it("recognises the journal stream set up by systemd", () => {
        const dir = mkdtempSync(join(tmpdir(), "log-test-"));
        const fd = openSync(join(dir, "stream"), "w");
        try {
            const stat = fstatSync(fd, { bigint: true });
            assert.equal(isJournalStream(`${stat.dev}:${stat.ino}`, fd), true);
            assert.equal(isJournalStream(`${stat.dev}:${stat.ino + 1n}`, fd), false);
            assert.equal(isJournalStream(undefined, fd), false);
            assert.equal(isJournalStream("", fd), false);
            assert.equal(isJournalStream("not:a-number", fd), false);
        } finally {
            closeSync(fd);
            rmSync(dir, { recursive: true, force: true });
        }
        assert.equal(isJournalStream("1:2", fd), false, "closed descriptor");
    });
});
