import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MoviesPage } from "./movies/MoviesPage";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MoviesPage />
  </StrictMode>,
);
