import { Telegraf, Markup } from 'telegraf';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const ADMIN_CHAT_ID  = process.env.ADMIN_CHAT_ID;
const CONTACT_PHONE    = process.env.CONTACT_PHONE    || '+998901234567';
const CONTACT_USERNAME = process.env.CONTACT_USERNAME  || '';

if (!TELEGRAM_TOKEN) { console.error("XATO: TELEGRAM_TOKEN topilmadi."); process.exit(1); }
if (!GROQ_API_KEY && !GEMINI_API_KEY) { console.error("XATO: AI kalit kerak."); process.exit(1); }

const bot  = new Telegraf(TELEGRAM_TOKEN);
const groq = GROQ_API_KEY   ? new Groq({ apiKey: GROQ_API_KEY })          : null;
const ai   = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// ===== Bilim bazasi =====
const SYSTEM_PROMPT = `
Sen "Mizan Marketing" agentligining tajribali va ishonchli menejerisan.
Mijozlar bilan FAQAT "Siz"lab, professional va samimiy muloqot qil.

SUHBAT USLUBI:
- Har javob 3-5 gapdan iborat bo'lsin. Na juda qisqa, na juda uzun.
- Mijozning muammosiga qiziqish bildir, empatsiya ko'rsat.
- Har javob oxirida bitta aniq savolni ber (mijozni keyingi qadamga yo'naltiradigan).
- "Men AI emasman" — hech qachon bu haqda gapirma.
- So'zlarni takrorlama, har gal yangi boshlanish ishlat.
- Mijoz raqam qoldirsa yoki buyurtma bergisi kelsa — rag'batlantir.

XIZMATLAR VA NARXLAR:
- SMM (Ijtimoiy tarmoqlarni boshqarish): oyiga $300 dan. Kontent, dizayn, posting kiradi.
- Target reklama: $150 dan. Facebook/Instagram/TikTok. CPM, CPC asosida.
- Logo & Brending: $100-300. Logotip, brand book, vizitka.
- Video Montaj: bitta video $20-50. Reels, YouTube, reklama videolari.
(Narxlarni faqat mijoz so'raganda yoki so'rov oxiriga yaqin ayt.)

MAQSAD: Mijozdan telefon raqam olish yoki uchrashuv belgilash.
`;

const JSON_FORMAT = `
JAVOB FORMATI — Faqat sof JSON (markdown yoki izoh yo'q):
{
  "reply": "Mijozga yoziladigan javob matni",
  "inline_buttons": ["Variant 1", "Variant 2", "Variant 3"],
  "keyboard": [["Tugma 1", "Tugma 2"], ["Tugma 3"]]
}

"inline_buttons" qoidalari:
- Mijoz bosishi mumkin bo'lgan 2-4 ta ANIQ javob varianti
- Savol bo'lsa — javob variantlari (masalan: "1 000", "10 000", "100 000+")
- Rozilik so'rasa — "Ha, qiziqarli", "Narxni bilmoqchiman", "Uchrashuv belgilaymiz"
- Har doim kontekstga mos bo'lsin

"keyboard" qoidalari:
- Pastki menyu — navigatsiya uchun 2-4 ta tugma
- Agar mijoz biror xizmat haqida so'rasa, o'sha sohaga oid tugmalar qo'y
- Default: [["📱 SMM", "🎯 Target"], ["🎬 Montaj", "🎨 Logo"], ["📞 Bog'lanish"]]
- Savol-javob davom etayotganda: [["✅ Ha, davom eting", "💰 Narxlar"], ["📞 Menejer kerak", "⬅️ Bosh menyu"]]
- Faqat 1-3 qator, har qatorda max 2 ta tugma
`;

// ===== Xotira =====
const userHistory = new Map();
const MAX_PAIRS    = 8;
const SESSION_TTL  = 3 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [uid, s] of userHistory.entries()) {
    if (now - s.lastActive > SESSION_TTL) userHistory.delete(uid);
  }
}, 30 * 60 * 1000);

const getSession = (uid) => userHistory.get(uid) || { messages: [], lastActive: Date.now() };
const saveSession = (uid, messages) => {
  userHistory.set(uid, { messages: messages.slice(-(MAX_PAIRS * 2)), lastActive: Date.now() });
};

// ===== Standart pastki menyu =====
const DEFAULT_KEYBOARD = [['📱 SMM', '🎯 Target'], ['🎬 Montaj', '🎨 Logo'], ["📞 Bog'lanish"]];

// ===== JSON parse =====
function parseAI(raw) {
  try {
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const p = JSON.parse(cleaned);
    return {
      reply:          typeof p.reply === 'string' ? p.reply.trim() : raw.trim(),
      inline_buttons: Array.isArray(p.inline_buttons) ? p.inline_buttons.filter(Boolean).slice(0, 4) : [],
      keyboard:       Array.isArray(p.keyboard) && p.keyboard.length ? p.keyboard : DEFAULT_KEYBOARD,
    };
  } catch {
    return { reply: raw.trim(), inline_buttons: [], keyboard: DEFAULT_KEYBOARD };
  }
}

// ===== Keyboard yasash =====
function buildReplyKeyboard(rows) {
  return Markup.keyboard(rows).resize();
}

function buildInlineKeyboard(buttons) {
  if (!buttons.length) return null;
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    const row = [Markup.button.callback(buttons[i], `q:${buttons[i]}`)];
    if (buttons[i + 1]) row.push(Markup.button.callback(buttons[i + 1], `q:${buttons[i + 1]}`));
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
}

// ===== Javob yuborish =====
async function sendBotReply(ctx, parsed) {
  const replyKeyboard = buildReplyKeyboard(parsed.keyboard);
  const inlineKb      = buildInlineKeyboard(parsed.inline_buttons);

  if (inlineKb) {
    // Inline buttonlar + pastki menyu
    await ctx.reply(parsed.reply, {
      reply_markup: {
        inline_keyboard: inlineKb.reply_markup.inline_keyboard,
        keyboard:        replyKeyboard.reply_markup.keyboard,
        resize_keyboard: true,
      }
    });
  } else {
    await ctx.reply(parsed.reply, replyKeyboard);
  }
}

// ===== Typing loop =====
async function startTyping(ctx) {
  await ctx.sendChatAction('typing');
  const t = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4500);
  return () => clearInterval(t);
}

// ===== Groq =====
async function callGroq(messages, userMsg) {
  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + JSON_FORMAT },
      ...messages,
      { role: 'user', content: userMsg }
    ],
    temperature: 0.75,
    max_tokens:  600,
  });
  return res.choices[0]?.message?.content?.trim();
}

// ===== Gemini (fallback) =====
async function callGemini(messages, userMsg, inlineData = null) {
  const history = messages.map(m =>
    `${m.role === 'user' ? 'Mijoz' : 'Menejer'}: ${m.content}`
  ).join('\n');

  const prompt = `${SYSTEM_PROMPT}${JSON_FORMAT}\n\nSuhbat tarixi:\n${history}\n\nMijoz: ${userMsg}\nMenejer javobi:`;
  const parts = [{ text: prompt }];
  if (inlineData) parts.push({ inlineData });

  const res = await ai.models.generateContent({
    model: 'gemini-1.5-flash',
    contents: [{ role: 'user', parts }]
  });
  return res.text.trim();
}

// ===== Whisper =====
async function transcribeVoice(buffer) {
  if (!groq) return null;
  try {
    const file = new File([buffer], 'voice.ogg', { type: 'audio/ogg' });
    const t = await groq.audio.transcriptions.create({ file, model: 'whisper-large-v3', language: 'uz' });
    return t.text;
  } catch (e) { console.error("Whisper:", e.message); return null; }
}

// ===== Asosiy handler =====
async function handleMessage(ctx, userId, userText, voiceBuffer = null) {
  const session = getSession(userId);
  let { messages } = session;

  const stopTyping = await startTyping(ctx);

  try {
    let raw = null;
    let effectiveText = userText;

    // Groq (asosiy)
    if (groq) {
      try {
        if (voiceBuffer) {
          const t = await transcribeVoice(voiceBuffer);
          if (t) { effectiveText = t; console.log(`🎤 "${t}"`); }
        }
        raw = await callGroq(messages, effectiveText);
        console.log('✅ Groq');
      } catch (e) { console.error("⚠️ Groq:", e.message); }
    }

    // Gemini (fallback)
    if (!raw && ai) {
      try {
        const inlineData = (voiceBuffer && !groq)
          ? { data: voiceBuffer.toString('base64'), mimeType: 'audio/ogg' }
          : null;
        raw = await callGemini(messages, effectiveText, inlineData);
        console.log('✅ Gemini fallback');
      } catch (e) { console.error("⚠️ Gemini:", e.message); }
    }

    stopTyping();

    if (!raw) {
      await ctx.reply("Kechirasiz, hozir nosozlik bor. Iltimos, keyinroq urinib ko'ring. 🙏",
        buildReplyKeyboard(DEFAULT_KEYBOARD));
      return;
    }

    const parsed = parseAI(raw);
    console.log(`💬 "${parsed.reply.slice(0, 60)}..." | 🔘 [${parsed.inline_buttons.join(' | ')}]`);

    messages = [...messages,
      { role: 'user',      content: effectiveText },
      { role: 'assistant', content: parsed.reply }
    ];
    saveSession(userId, messages);

    await sendBotReply(ctx, parsed);

  } catch (err) {
    stopTyping();
    console.error("❌ Xato:", err);
    await ctx.reply("Texnik nosozlik. Iltimos, keyinroq qayta urinib ko'ring. 🙏",
      buildReplyKeyboard(DEFAULT_KEYBOARD));
  }
}

// ===== /start =====
bot.start((ctx) => {
  userHistory.delete(ctx.from.id);
  const name = ctx.from.first_name || 'Mehmon';
  ctx.reply(
    `Assalomu alaykum, ${name}! 👋\n\nMen Mizan Marketing agentligining virtual menejeriman.\nBiz sizning biznesingizni ijtimoiy tarmoqlarda ko'tarish uchun shu yerdamiz!\n\nQaysi yo'nalish qiziqtirayapti?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 SMM',       callback_data: 'q:SMM xizmati haqida batafsil aytib bering' },
           { text: '🎯 Target',    callback_data: 'q:Target reklama qanday ishlaydi' }],
          [{ text: '🎬 Montaj',    callback_data: 'q:Video montaj xizmatingiz haqida' },
           { text: '🎨 Logo',      callback_data: 'q:Logo va brending xizmati haqida' }],
          [{ text: "💬 Savol bermoqchiman", callback_data: 'q:Sizdan bir necha savol so\'ramoqchiman' }]
        ],
        keyboard: DEFAULT_KEYBOARD,
        resize_keyboard: true,
      }
    }
  );
});

// ===== Inline button =====
bot.action(/^q:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const text = ctx.match[1];
  await handleMessage(ctx, ctx.from.id, text);
});

// ===== Pastki tugmalar — kontekstga mos yo'naltirish =====
const KEYBOARD_HANDLERS = {
  '📱 SMM':        "SMM xizmati haqida batafsil ma'lumot bering",
  '🎯 Target':     "Target reklama xizmatingiz haqida to'liq tushuntiring",
  '🎬 Montaj':     "Video montaj xizmatingiz haqida gapiring",
  '🎨 Logo':       "Logo va brending xizmati haqida aytib bering",
  "📞 Bog'lanish": null, // maxsus handler
  '⬅️ Bosh menyu': null,
  // Dinamik buttonlar — catch-all orqali ishlaydi
};

bot.hears("📞 Bog'lanish", async (ctx) => {
  const usernameText = CONTACT_USERNAME ? `\n💬 Telegram: ${CONTACT_USERNAME}` : '';
  await ctx.reply(
    `📞 Raqamimiz: ${CONTACT_PHONE}${usernameText}\n\nYoki o'zingizning raqamingizni qoldiring — mutaxassisimiz darhol aloqaga chiqadi:`,
    Markup.keyboard([
      [Markup.button.contactRequest('📱 Raqamimni yuborish')],
      ['⬅️ Bosh menyu']
    ]).resize()
  );
});

bot.hears('⬅️ Bosh menyu', (ctx) => {
  userHistory.delete(ctx.from.id);
  ctx.reply("Bosh menyuga qaytdik! Qaysi xizmat qiziqtirayapti?", buildReplyKeyboard(DEFAULT_KEYBOARD));
});

// Qolgan barcha tugmalar / matn
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  // Maxsus tugmalar catch
  if (KEYBOARD_HANDLERS[text] !== undefined) {
    if (KEYBOARD_HANDLERS[text]) {
      await handleMessage(ctx, ctx.from.id, KEYBOARD_HANDLERS[text]);
    }
    return;
  }
  await handleMessage(ctx, ctx.from.id, text);
});

// ===== Ovoz =====
bot.on('voice', async (ctx) => {
  try {
    const link   = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const res    = await fetch(link.href);
    const buffer = Buffer.from(await res.arrayBuffer());
    await handleMessage(ctx, ctx.from.id, '[Ovozli xabar]', buffer);
  } catch (e) {
    console.error("Ovoz xatosi:", e);
    await ctx.reply("Ovozni tahlil qilishda muammo. Yozma xabar yuborasizmi?",
      buildReplyKeyboard(DEFAULT_KEYBOARD));
  }
});

// ===== Kontakt =====
bot.on('contact', async (ctx) => {
  const c = ctx.message.contact;
  await ctx.reply(
    `✅ Rahmat, ${c.first_name}! Raqamingizni ${c.phone_number} qabul qildik.\nMutaxassisimiz 5-10 daqiqa ichida aloqaga chiqadi! 🤝`,
    buildReplyKeyboard(DEFAULT_KEYBOARD)
  );

  if (ADMIN_CHAT_ID) {
    try {
      await ctx.telegram.sendMessage(ADMIN_CHAT_ID,
        `📥 YANGI LEAD!\n\n👤 ${c.first_name} ${c.last_name || ''}\n` +
        `📞 ${c.phone_number}\n🔗 @${ctx.from.username || 'yo\'q'}\n` +
        `🆔 ${ctx.from.id}\n⏰ ${new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}`
      );
    } catch (e) { console.error("Admin xato:", e.message); }
  }
});

// ===== Health-check HTTP server (Koyeb / Render uchun) =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', bot: 'Mizan Bot', uptime: process.uptime() }));
}).listen(PORT, () => console.log(`🌐 Health-check: http://localhost:${PORT}`));

// ===== Ishga tushirish =====
const provider = groq ? 'Groq (Llama 3.3)' : 'Gemini';
const fallback  = groq && ai ? ' + Gemini fallback' : '';
console.log(`🚀 Bot ishlamoqda [${provider}${fallback}]`);

bot.launch()
  .then(() => console.log('✅ Bot tayyor! Dinamik keyboard + inline buttons faol.'))
  .catch(e => console.error("❌ Ishga tushirishda xato:", e));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
