import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function run() {
  try {
    const response = await ai.models.list();
    const modelsList = response.models || [];
    console.log("Available models:", modelsList.map(m => m.name));
  } catch(e) {
    console.error("Xato yuz berdi:", e.message);
  }
}
run();
