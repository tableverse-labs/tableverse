import { createRoot } from "react-dom/client";
import { setAdapter } from "./api/index";
import { DuckDbAdapter } from "./api/duckdb/adapter";
import { useUiStore } from "./stores/ui";
import { AppLite } from "./AppLite";

setAdapter(new DuckDbAdapter());
useUiStore.setState({ showSourceManager: true });

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");
createRoot(root).render(<AppLite />);
