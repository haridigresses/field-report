import path from "node:path";
import { fileURLToPath } from "node:url";

// Tests seat the example config, which mirrors the historical default panel.
export const EXAMPLE_SEATS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../config/config.example.json");
process.env.FIELD_REPORT_CONFIG = EXAMPLE_SEATS;
