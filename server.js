import express from "express";
import cors from "cors";
import spinHandler from "./api/spin.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Route
app.post("/api/spin", spinHandler);

// Start server
app.listen(PORT, () => {
  console.log(`Spin API listening on port ${PORT}`);
});
