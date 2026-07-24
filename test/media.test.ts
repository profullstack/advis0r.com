/**
 * Media ingestion tests (PRD v3 §2).
 *
 * The network-dependent parts (yt-dlp, Groq, podcast feeds) are exercised
 * live during development; what is unit-tested here is the deterministic core
 * that decides whether a transcript is usable: caption parsing and timestamps,
 * ASR chunk planning, and speaker attribution.
 */
import { describe, expect, test } from "bun:test";
import {
  cuesToSegments,
  formatTimestamp,
  parseCaptions,
  parseCaptionsToSegments,
  parseTimestamp,
} from "../src/providers/media/captions.ts";
import {
  estimateCostUsd,
  parseVerboseJson,
  planChunks,
  CHUNK_SECONDS,
  OVERLAP_SECONDS,
} from "../src/providers/media/asr.ts";
import { parseDuration, parseEpisodes, episodeMentions } from "../src/providers/media/podcast.ts";
import { classifyVideo } from "../src/providers/media/index.ts";
import { isBotBlocked, timestampUrl, videoId } from "../src/providers/media/youtube.ts";
import {
  attributeSegment,
  attributeSegments,
  attributionRate,
  normalizeName,
} from "../src/signals/speakers.ts";

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Thanks everyone for joining the call.

00:00:04.000 --> 00:00:09.500
We are raising our full-year guidance to $210 million.

00:00:09.500 --> 00:00:14.000
Backlog grew 47% year over year.
`;

describe("caption parsing", () => {
  test("parses cues with millisecond offsets", () => {
    const cues = parseCaptions(VTT);
    expect(cues).toHaveLength(3);
    expect(cues[0]!.startMs).toBe(1000);
    expect(cues[1]!.startMs).toBe(4000);
    expect(cues[1]!.text).toContain("raising our full-year guidance");
  });

  test("timestamps round-trip", () => {
    expect(parseTimestamp("00:00:04.000")).toBe(4000);
    expect(parseTimestamp("01:02:03.500")).toBe(3_723_500);
    expect(parseTimestamp("01:02.250")).toBe(62_250);
    expect(formatTimestamp(3_723_500)).toBe("1:02:03");
    expect(formatTimestamp(62_000)).toBe("1:02");
  });

  test("SRT input with comma decimals and sequence numbers parses", () => {
    const srt = "1\n00:00:02,000 --> 00:00:05,000\nRevenue rose sharply.\n\n";
    const cues = parseCaptions(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.startMs).toBe(2000);
    expect(cues[0]!.text).toBe("Revenue rose sharply.");
  });

  test("YouTube inline word timings and <c> tags are stripped", () => {
    const messy =
      "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<00:00:01.500><c> we</c><00:00:02.000><c> raised</c> guidance\n";
    expect(parseCaptions(messy)[0]!.text).toBe("we raised guidance");
  });

  test("rolling duplicate captions collapse instead of repeating", () => {
    // YouTube repeats the previous cue's tail so text scrolls smoothly.
    const rolling = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:03.000",
      "we are raising",
      "",
      "00:00:03.000 --> 00:00:05.000",
      "we are raising guidance today",
      "",
      "00:00:05.000 --> 00:00:07.000",
      "guidance today because demand accelerated",
      "",
    ].join("\n");
    const text = parseCaptions(rolling).map((c) => c.text).join(" ");
    expect(text).toBe("we are raising guidance today because demand accelerated");
  });

  test("segments preserve the start offset of their first cue", () => {
    const segments = cuesToSegments(parseCaptions(VTT), 40);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]!.startMs).toBe(1000);
    for (const s of segments) expect(typeof s.startMs).toBe("number");
  });

  test("empty input yields no segments rather than throwing", () => {
    expect(parseCaptionsToSegments("")).toEqual([]);
  });
});

describe("ASR chunk planning", () => {
  test("short audio is a single chunk", () => {
    const plans = planChunks(60_000);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.startMs).toBe(0);
  });

  test("long audio is split with overlap so sentences are not cut", () => {
    const hourMs = 3_600_000;
    const plans = planChunks(hourMs);
    expect(plans.length).toBeGreaterThan(1);
    expect(plans[0]!.startMs).toBe(0);
    // Every chunk after the first starts early by exactly the overlap.
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i]!.startMs).toBe(i * CHUNK_SECONDS * 1000 - OVERLAP_SECONDS * 1000);
    }
  });

  test("chunks cover the whole timeline", () => {
    const durationMs = 5_000_000;
    const plans = planChunks(durationMs);
    const last = plans[plans.length - 1]!;
    expect(last.startMs + last.durationMs).toBeGreaterThanOrEqual(durationMs - 1);
  });

  test("zero duration degrades to one empty chunk", () => {
    expect(planChunks(0)).toEqual([{ startMs: 0, durationMs: 0 }]);
  });

  test("verbose_json maps to millisecond cues", () => {
    const cues = parseVerboseJson({
      segments: [
        { start: 1.5, end: 4.25, text: " We raised guidance. " },
        { start: 4.25, end: 6, text: "" },
      ],
    });
    expect(cues).toHaveLength(1);
    expect(cues[0]!.startMs).toBe(1500);
    expect(cues[0]!.endMs).toBe(4250);
    expect(cues[0]!.text).toBe("We raised guidance.");
  });

  test("a plain-text response still yields one cue", () => {
    expect(parseVerboseJson({ text: "hello world" })[0]!.text).toBe("hello world");
  });

  test("cost estimate matches the published rate", () => {
    // One hour at $0.04/hr.
    expect(estimateCostUsd(3_600_000)).toBeCloseTo(0.04, 4);
  });
});

describe("podcast feed parsing", () => {
  const RSS = `<rss><channel>
    <item>
      <title>NVIDIA: OpenAI and the Future of Compute</title>
      <link>https://example.com/ep1</link>
      <pubDate>Tue, 11 Jun 2026 10:00:00 GMT</pubDate>
      <itunes:duration>1:20:47</itunes:duration>
      <enclosure url="https://cdn.example.com/ep1.mp3" length="77556923" type="audio/mpeg"/>
    </item>
    <item>
      <title>No audio here</title>
      <link>https://example.com/ep2</link>
    </item>
  </channel></rss>`;

  test("only items with an audio enclosure become episodes", () => {
    const eps = parseEpisodes(RSS, "BG2Pod");
    expect(eps).toHaveLength(1);
    expect(eps[0]!.audioUrl).toBe("https://cdn.example.com/ep1.mp3");
    expect(eps[0]!.publishedAt).toBe("2026-06-11");
    expect(eps[0]!.durationMs).toBe(4847000);
  });

  test("duration parses both seconds and HH:MM:SS", () => {
    expect(parseDuration("3600")).toBe(3_600_000);
    expect(parseDuration("1:20:47")).toBe(4_847_000);
    expect(parseDuration("20:47")).toBe(1_247_000);
    expect(parseDuration(undefined)).toBeUndefined();
  });

  test("episode matching is conservative about attributing speech", () => {
    expect(episodeMentions({ title: "NVIDIA: the future" }, "NVDA", "NVIDIA Corporation")).toBe(true);
    expect(episodeMentions({ title: "Weekly market wrap" }, "NVDA", "NVIDIA Corporation")).toBe(false);
  });
});

describe("video classification and links", () => {
  test("titles map onto the event taxonomy", () => {
    expect(classifyVideo("Acme Q2 2026 Earnings Call")).toBe("earnings_call");
    expect(classifyVideo("Acme Investor Day 2026")).toBe("investor_day");
    expect(classifyVideo("CEO Keynote at GTC")).toBe("keynote");
    expect(classifyVideo("Fireside chat with the CFO")).toBe("fireside_chat");
    expect(classifyVideo("Random clip")).toBe("video");
  });

  test("video ids parse from all common URL shapes", () => {
    expect(videoId("https://www.youtube.com/watch?v=abc123XYZ")).toBe("abc123XYZ");
    expect(videoId("https://youtu.be/abc123XYZ")).toBe("abc123XYZ");
    expect(videoId("https://example.com/nope")).toBeNull();
  });

  test("timestamp links point at the exact second", () => {
    expect(timestampUrl("https://www.youtube.com/watch?v=x", 125_000)).toBe(
      "https://www.youtube.com/watch?v=x&t=125",
    );
  });

  test("bot-block detection distinguishes auth failure from missing captions", () => {
    expect(isBotBlocked("ERROR: Sign in to confirm you’re not a bot.")).toBe(true);
    expect(isBotBlocked("WARNING: no subtitles found")).toBe(false);
  });
});

describe("speaker attribution", () => {
  test("Name -- Title form", () => {
    const { attribution, text } = attributeSegment(
      "Jensen Huang -- Chief Executive Officer: demand is accelerating.",
    );
    expect(attribution?.speaker).toBe("Jensen Huang");
    expect(attribution?.speakerTitle).toContain("Chief Executive Officer");
    expect(text).not.toContain("Jensen Huang --");
  });

  test("Name, Title: form", () => {
    const { attribution } = attributeSegment("Colette Kress, CFO: margins expanded.");
    expect(attribution?.speaker).toBe("Colette Kress");
    expect(attribution?.speakerTitle).toBe("CFO");
  });

  test("ALL CAPS labels are normalized", () => {
    expect(normalizeName("JENSEN HUANG")).toBe("Jensen Huang");
    expect(normalizeName("Jensen Huang")).toBe("Jensen Huang");
  });

  test("Operator is recognised", () => {
    expect(attributeSegment("Operator: our first question comes from...").attribution?.speaker)
      .toBe("Operator");
  });

  test("ordinary sentences are not mistaken for speaker labels", () => {
    expect(attributeSegment("Revenue: 12% growth this quarter.").attribution).toBeUndefined();
    expect(attributeSegment("We raised guidance today.").attribution).toBeUndefined();
  });

  test("attribution carries forward across a speaker's turn", () => {
    const segs = attributeSegments([
      { index: 0, text: "Jensen Huang -- CEO: demand is accelerating." },
      { index: 1, text: "We expect that to continue next quarter." },
      { index: 2, text: "Operator: next question please." },
      { index: 3, text: "Thank you." },
    ]);
    expect(segs[0]!.speaker).toBe("Jensen Huang");
    expect(segs[1]!.speaker).toBe("Jensen Huang"); // inherited within the turn
    expect(segs[2]!.speaker).toBe("Operator");
    expect(segs[3]!.speaker).toBe("Operator");
    expect(attributionRate(segs)).toBe(1);
  });

  test("unattributable transcripts report a zero rate rather than guessing", () => {
    const segs = attributeSegments([{ index: 0, text: "some unlabelled prose here." }]);
    expect(segs[0]!.speaker).toBeUndefined();
    expect(attributionRate(segs)).toBe(0);
  });
});
