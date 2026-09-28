"""Word timestamps for BookReel's narration, with faster-whisper.

Usage: python align.py <job.json> <out.json>

job.json:
  {"audio": "<the mastered voice track>", "model": "base.en", "modelDir": "...",
   "windows": [{"start": s, "end": e, "prompt": "<the beat's script text>"}, ...]}

Transcribes the FINAL mastered track -- the audio the viewer hears -- one beat
window at a time, with word timestamps, and writes every timestamp in that
track's own clock (window offset added back). Deliberately does no matching:
which recognised word is which script word is decided in TypeScript
(`media/word-timing.ts`), where it is unit tested.

Each window's script text is passed as `initial_prompt`, which steers spelling
(names, numbers) toward what was actually said; the timestamps still come from
the audio.

Progress on stdout as JSON lines: {"type":"window","index":i}, then
{"type":"done"}. A failure is one {"type":"error","code":...,"message":...}
line and exit 2.
"""

import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(code, message):
    emit({"type": "error", "code": code, "message": message})
    sys.exit(2)


def main():
    if len(sys.argv) != 3:
        fail("usage", "usage: align.py <job.json> <out.json>")
    with open(sys.argv[1], encoding="utf-8") as fh:
        job = json.load(fh)

    try:
        from faster_whisper import WhisperModel
        from faster_whisper.audio import decode_audio
    except ImportError as err:
        fail("no_faster_whisper", "faster-whisper is not installed: %s" % err)

    try:
        model = WhisperModel(job.get("model", "base.en"), device="cpu", compute_type="int8",
                             download_root=job.get("modelDir"))
    except Exception as err:  # noqa: BLE001
        fail("model", "The speech model could not be loaded: %s" % err)

    rate = 16000
    audio = decode_audio(job["audio"], sampling_rate=rate)
    total = len(audio) / rate

    windows = []
    for i, w in enumerate(job["windows"]):
        start = max(0.0, float(w["start"]))
        end = min(total, float(w["end"]))
        words = []
        if end - start > 0.05:
            chunk = audio[int(start * rate):int(end * rate)]
            segments, _info = model.transcribe(
                chunk,
                language="en",
                word_timestamps=True,
                beam_size=5,
                condition_on_previous_text=False,
                initial_prompt=w.get("prompt") or None,
                vad_filter=False,
            )
            for seg in segments:
                for wd in seg.words or []:
                    words.append({
                        "word": wd.word.strip(),
                        "start": round(start + wd.start, 3),
                        "end": round(start + wd.end, 3),
                        "p": round(wd.probability, 3),
                    })
        windows.append({"start": start, "end": end, "words": words})
        emit({"type": "window", "index": i})

    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        json.dump({"model": job.get("model", "base.en"), "duration": total, "windows": windows}, fh)
    emit({"type": "done"})


if __name__ == "__main__":
    main()
