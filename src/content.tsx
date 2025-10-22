import { GoogleGenAI, Type } from "@google/genai";

async function callGeminiApi(pageText: string, GEMINI_API_KEY: string): Promise<string> {
  const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await genAI.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{
      parts: [{
        text: `Analyze the following text and extract all board game names mentioned. Only include games that are likely to be found on BoardGameGeek. Do not include any other text in your response. Text: "${pageText}"`
      }]
    }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          games: {
            type: Type.ARRAY,
            description: "A list of board game names found in the text.",
            items: {
              type: Type.STRING
            }
          }
        }
      },
    },
  });

  const data = response.candidates?.[0]?.content?.parts?.[0]?.text;
  let boardGames = "None found";

  if (data) {
    try {
      const parsedData = JSON.parse(data);
      if (parsedData.games && Array.isArray(parsedData.games)) {
        boardGames = parsedData.games.join(", ");
      }
    } catch (parseError) {
      console.error("Error parsing Gemini API response:", parseError);
    }
  }
  return boardGames;
}

chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  if (request.action === "displayMessage") {
    const messageDiv = document.createElement('div');
    messageDiv.textContent = "Working...";
    messageDiv.style.cssText = 'position: fixed; top: 0; left: 0; background-color: lightblue; z-index: 99999; padding: 5px;';
    document.body.prepend(messageDiv);

    try {
      const pageText = document.body.innerText;
      const GEMINI_API_KEY = process.env.GEMINI_API_KEY as string;
      const boardGames = await callGeminiApi(pageText, GEMINI_API_KEY);

      console.log("Identified Board Games:", boardGames);
      messageDiv.textContent = `Found: ${boardGames}`;

    } catch (error: unknown) {
      console.error("Error making Gemini API call:", error);
      messageDiv.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
});
