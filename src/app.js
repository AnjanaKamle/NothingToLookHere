import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import apiRoutes from "./routes/api.js";

const here = import.meta.dirname; // the folder this file is in (src/)
export const app = express();

app.use(express.json());
app.use(cookieParser());
app.use("/api", apiRoutes);
app.use(express.static(path.join(here, "../public")));
app.use((_req, res) => res.sendFile(path.join(here, "../public/index.html")));
app.use((error, _req, res, _next) => {
  console.error(error.message);
  if (error.code === "P2002")
    return res.status(409).json({ error: "That value is already in use" });
  return res.status(500).json({ error: "Something went wrong" });
});
