import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function run() {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: 'Salom, kimsan?',
    });
    console.log("Gemini javobi:", response.text);
  } catch(e) {
    console.error("Xato yuz berdi:", e.message);
  }
}
run();
