import type { FC } from "react";
import { createRoot } from "react-dom/client";

import { Main } from "./components/Main";

const App: FC = () => {
	return <Main />;
};

const dom = document.getElementById("root");
if (dom) {
	const root = createRoot(dom);
	root.render(<App />);
}
