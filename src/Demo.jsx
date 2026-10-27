import React, { useEffect, useState } from "react";
import { Play } from "lucide-react";
export default function Demo({ paths }) {
  const [step, setStep] = useState(0);
  const [count, setCount] = useState(0);
  const [replay, setReplay] = useState(0);
  useEffect(() => {
    setStep(0);
    setCount(0);
    const timers = paths.map((_, i) =>
      setTimeout(() => setCount(i + 1), 400 + i * 400),
    );
    timers.push(
      setTimeout(() => setStep(1), 3800),
      setTimeout(() => setStep(2), 5300),
      setTimeout(() => setStep(3), 8000),
      setTimeout(() => setStep(4), 10500),
    );
    return () => timers.forEach(clearTimeout);
  }, [paths, replay]);
  return (
    <div className="demo-player">
      <h2>A little scribble. A little magic.</h2>
      <p>
        13-second concept demo · Pre-made artwork and style previews, no API
        calls.
      </p>
      <div className="demo-frames">
        <svg viewBox="0 0 400 400" aria-label="Animated example pumpkin sketch">
          {paths.slice(0, count).map((p, i) => (
            <polyline
              key={i}
              points={p.map((p) => p.join(",")).join(" ")}
              stroke="#b85e30"
              strokeWidth="3"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </svg>
        <div className={`demo-result ${step === 3 ? "crochet" : ""}`}>
          {step >= 2 ? (
            <>
              <img
                src="/pumpkin-clay.png"
                alt="Pre-made clay pumpkin example"
              />
              {step === 3 && <div className="yarn-texture" />}
            </>
          ) : (
            <span>
              {step === 1 ? "A little magic…" : "A goofy little beginning"}
            </span>
          )}
        </div>
      </div>
      <strong>
        {
          [
            "Draw something goofy",
            "Choose Claymation",
            "Meet your little creature",
            "Try a Crochet preview",
            "One sketch. So many possibilities.",
          ][step]
        }
      </strong>
      {step === 4 && (
        <div className="demo-style-list">
          Claymation · Cozy watercolor · Spooky cinematic · Crochet plushie
        </div>
      )}
      <button className="demo-button" onClick={() => setReplay((n) => n + 1)}>
        <Play size={13} /> Replay demo
      </button>
    </div>
  );
}
