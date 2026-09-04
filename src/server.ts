import "dotenv/config";
import { createApp } from "./app.js";
import { DEFAULT_GATEWAY_CONFIG } from "./config/index.js";

const port = Number(process.env.PORT ?? DEFAULT_GATEWAY_CONFIG.port);
const app = createApp();

app.listen(port, () => {
  console.log(`LLM gateway listening on port ${port}`);
});
