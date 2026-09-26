import { createRoot } from "react-dom/client";
import QuoteForm from "./QuoteForm.tsx";

const target = document.getElementById("app");
if (target === null) throw new Error("Missing #app mount target");
createRoot(target).render(<QuoteForm />);
