import { useEffect, useRef, useState } from "react";
export const styleIds = ["claymation", "watercolor", "cinematic", "crochet"];
export const signatureFor = (paths, weird, character) =>
  JSON.stringify({ paths, weird, character });
export const matchingResult = (results, style, signature) =>
  results[style]?.signature === signature ? results[style] : null;

export function exportSketch(canvas) {
  const output = document.createElement("canvas");
  output.width = output.height = 1024;
  const context = output.getContext("2d");
  context.fillStyle = "#fcfaf5";
  context.fillRect(0, 0, 1024, 1024);
  context.drawImage(canvas, 0, 0, 1024, 1024);
  return output.toDataURL("image/png");
}
export function useGeneration({ paths, weird, character, canvas, style }) {
  const [configured, setConfigured] = useState(null);
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const request = useRef(null);
  const signature = signatureFor(paths, weird, character);
  const selected = matchingResult(results, style, signature);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/config", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((data) => setConfigured(data.configured === true))
      .catch((e) => {
        if (e.name !== "AbortError")
          setError(
            "Could not reach the pumpkin server. Check the connection and try again.",
          );
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, []);
  async function transform(all = false) {
    if (request.current) return;
    setError("");
    if (!paths.some((p) => p.color !== "#fcfaf5")) {
      setError("Add a little scribble first.");
      return;
    }
    const source = exportSketch(canvas.current);
    const indices = all
      ? styleIds
          .map((_, i) => i)
          .filter((i) => !matchingResult(results, i, signature))
      : [style];
    if (!indices.length) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      for (const [index, idx] of indices.entries()) {
        setProgress(
          all
            ? `Creating style ${index + 1} of ${indices.length}…`
            : "Finding the magic…",
        );
        const response = await fetch("/api/transform", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            sketch: source,
            style: styleIds[idx],
            character,
            keepWeirdness: weird,
          }),
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.error || "Could not transform this sketch. Please try again.",
          );
        if (!/^data:image\/png;base64,/.test(data.image || ""))
          throw new Error("The server returned no image. Please try again.");
        setConfigured(true);
        setResults((previous) => ({
          ...previous,
          [idx]: { image: data.image, source, signature },
        }));
      }
    } catch (e) {
      if (e.name !== "AbortError")
        setError(
          e.message || "Connection lost. Your sketch is safe; try again.",
        );
    } finally {
      request.current = null;
      setBusy(false);
      setProgress("");
    }
  }
  return {
    configured,
    results,
    selected,
    busy,
    error,
    progress,
    signature,
    transform,
    cancel: () => request.current?.abort(),
  };
}
