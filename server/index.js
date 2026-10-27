import { createApp } from "./app.js";
const development = process.argv.includes("--dev");
let vite;
if (development) {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
}
const app = createApp({ middleware: vite?.middlewares });
const port = Number(process.env.PORT || 5173);
app.listen(port, process.env.HOST || "0.0.0.0", () =>
  console.log(
    `Pumpkin studio: http://localhost:${port} (${process.env.OPENAI_API_KEY ? "live generation configured" : "API key not configured"})`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    app.close();
    app.closeAllConnections();
    Promise.resolve(vite?.close()).finally(() => process.exit(0));
  });
