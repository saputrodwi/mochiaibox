export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        {
          error: "Gunakan method POST."
        },
        405
      );
    }

    try {
      const body = await request.json();

      const action = body.action || "chat";
      const userId = body.userId || "default-user";

      if (action === "reset_memory") {
        await deleteMemory(env, userId);

        return jsonResponse({
          ok: true,
          text: "Memori berhasil dihapus."
        });
      }

      const message = body.message || "";
      const image = body.image || null;

      if (!message.trim() && !image) {
        return jsonResponse(
          {
            error: "Pesan atau gambar tidak boleh kosong."
          },
          400
        );
      }

      if (!env.GEMINI_API_KEY) {
        return jsonResponse(
          {
            error: "GEMINI_API_KEY belum disetel di Worker."
          },
          500
        );
      }

      if (!env.MOCHI_MEMORY) {
        return jsonResponse(
          {
            error: "KV binding MOCHI_MEMORY belum disetel di Worker."
          },
          500
        );
      }

      const memory = await getMemory(env, userId);

      const answer = await askGemini({
        env,
        message,
        image,
        memory
      });

      const updatedMemory = await updateMemoryWithGemini({
        env,
        oldMemory: memory,
        userMessage: message,
        aiAnswer: answer
      });

      await saveMemory(env, userId, updatedMemory);

      return jsonResponse({
        ok: true,
        model: env.GEMINI_MODEL || "gemini-2.5-flash",
        text: answer,
        memory: updatedMemory
      });
    } catch (err) {
      return jsonResponse(
        {
          error: err.message || "Terjadi error."
        },
        500
      );
    }
  }
};

async function askGemini({ env, message, image, memory }) {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";

  let prompt = "";

  if (image) {
    prompt = `
Kamu adalah Mochi AI Box.

Memori tentang user:
${memory || "-"}

Tugas:
- Baca gambar yang dikirim user.
- Jika gambar berisi teks, lakukan OCR.
- Jika user meminta terjemahan, terjemahkan ke bahasa Indonesia secara natural.
- Jika user hanya mengirim gambar tanpa instruksi, jelaskan isi gambar dan tulis teks yang terbaca.
- Jawab dalam bahasa Indonesia.
- Jangan terlalu kaku.
- Jangan terlalu banyak basa-basi.

Instruksi user:
${message || "Baca gambar ini dan jelaskan isi/teks yang terlihat."}
`.trim();
  } else {
    prompt = `
Kamu adalah Mochi AI Box, asisten AI yang menjawab dalam bahasa Indonesia.

Memori tentang user:
${memory || "-"}

Gaya jawaban:
- Jelas
- Natural
- Ramah
- Tidak terlalu kaku
- Jangan terlalu panjang kalau tidak diminta
- Kalau user meminta kode, berikan kode lengkap jika diperlukan
- Kalau user sedang membuat aplikasi, jawab bertahap dan mudah diikuti
- Jangan saya anda, kamu aku sudah cukup. 

Pesan user:
${message}
`.trim();
  }

  const parts = [
    {
      text: prompt
    }
  ];

  if (image && image.base64 && image.mimeType) {
    parts.push({
      inline_data: {
        mime_type: image.mimeType,
        data: image.base64
      }
    });
  }

  const geminiBody = {
    contents: [
      {
        role: "user",
        parts
      }
    ],
    generationConfig: {
      temperature: 0.6,
      topP: 0.9,
      maxOutputTokens: 4096
    }
  };

  const geminiUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":generateContent?key=" +
    env.GEMINI_API_KEY;

  const geminiRes = await fetch(geminiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(geminiBody)
  });

  const geminiData = await geminiRes.json();

  if (!geminiRes.ok) {
    throw new Error(
      "Gemini API error: " + JSON.stringify(geminiData, null, 2)
    );
  }

  return extractText(geminiData);
}

async function updateMemoryWithGemini({ env, oldMemory, userMessage, aiAnswer }) {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";

  const prompt = `
Kamu bertugas memperbarui memori singkat untuk asisten AI.

Memori lama:
${oldMemory || "-"}

Pesan terbaru user:
${userMessage || "-"}

Jawaban asisten:
${aiAnswer || "-"}

Aturan memori:
- Simpan hanya informasi yang berguna untuk percakapan berikutnya.
- Jangan simpan hal terlalu sementara.
- Jangan simpan data sensitif seperti password, API key, token, alamat lengkap, atau informasi pribadi berbahaya.
- Simpan preferensi user, proyek yang sedang dibuat, gaya jawaban yang disukai, dan konteks teknis yang relevan.
- Buat ringkas.
- Maksimal 1500 karakter.
- Jawab hanya isi memori baru, tanpa penjelasan tambahan.
`.trim();

  const geminiBody = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      topP: 0.8,
      maxOutputTokens: 700
    }
  };

  const geminiUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":generateContent?key=" +
    env.GEMINI_API_KEY;

  const res = await fetch(geminiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(geminiBody)
  });

  const data = await res.json();

  if (!res.ok) {
    return oldMemory || "";
  }

  const newMemory = extractText(data).trim();

  if (!newMemory || newMemory.length < 3) {
    return oldMemory || "";
  }

  return newMemory.slice(0, 1500);
}

async function getMemory(env, userId) {
  const key = getMemoryKey(userId);
  const value = await env.MOCHI_MEMORY.get(key);
  return value || "";
}

async function saveMemory(env, userId, memory) {
  const key = getMemoryKey(userId);
  await env.MOCHI_MEMORY.put(key, memory || "");
}

async function deleteMemory(env, userId) {
  const key = getMemoryKey(userId);
  await env.MOCHI_MEMORY.delete(key);
}

function getMemoryKey(userId) {
  return "memory:" + userId;
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];

  const text = parts
    .map((part) => part.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || "Tidak ada jawaban dari Gemini.";
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
