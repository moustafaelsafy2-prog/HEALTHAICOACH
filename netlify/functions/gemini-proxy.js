exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { prompt } = JSON.parse(event.body);

  if (!prompt) {
    return { statusCode: 400, body: 'Bad Request: Missing prompt' };
  }

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    return {
      statusCode: 200,
      body: JSON.stringify({ text }),
    };
  } catch (error) {
    console.error('Gemini API Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to get response from AI model.' }),
    };
  }
};
