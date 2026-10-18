
process.env.GEMINI_API_KEY ||= 'test-key-not-used';
const { buildAnalysisRequest, getAnalysisConfigForTest } = await import('./geminiService.js');

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`✅ ${label}`);
    pass++;
  } else {
    console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

const withRole = { systemPrompt: 'あなたは会議の議事録を作成する専門家です。', userPrompt: '', maxOutputTokens: 8000 };
const noRole = { userPrompt: '', maxOutputTokens: 2000 };

{
  const req = buildAnalysisRequest(withRole, 'サンプルの本文');

  check('systemPrompt を systemInstruction に入れる', req.config.systemInstruction === withRole.systemPrompt);
  check('contents は user の 1 件だけ', req.contents.length === 1 && req.contents[0].role === 'user', `${req.contents.length}ターン`);

  const serialized = JSON.stringify(req);
  check('あらかじめ用意した応答の文が含まれない', !serialized.includes('承知しました'));
  check('role が model の項目が無い', !req.contents.some((c) => c.role === 'model'));

  check('本文を最初のパートにそのまま入れる', req.contents[0].parts[0].text === 'サンプルの本文');
  check('最大トークン数を設定どおりにし、温度は指定しない', !('temperature' in req.config) && req.config.maxOutputTokens === 8000);
}

{
  const req = buildAnalysisRequest(noRole, '本文');
  check('systemPrompt が無ければ systemInstruction を入れない', !('systemInstruction' in req.config));
  check('systemPrompt が無くても contents は 1 件', req.contents.length === 1);
}

{
  const images = [
    { mimeType: 'image/png', data: 'AAAA' },
    { mimeType: 'image/jpeg', data: 'BBBB' },
  ];
  const req = buildAnalysisRequest(withRole, '本文', images as any);

  check('画像を付けても contents は 1 件', req.contents.length === 1);
  check('パートは本文 1 つと画像 2 つ', req.contents[0].parts.length === 3, `${req.contents[0].parts.length}パート`);
  check('画像を inlineData として入れる', req.contents[0].parts[1].inlineData?.mimeType === 'image/png' && req.contents[0].parts[2].inlineData?.data === 'BBBB');
  check('画像を付けても systemInstruction を保つ', req.config.systemInstruction === withRole.systemPrompt);
}

{
  const req = buildAnalysisRequest(withRole, '本文', undefined);
  check('画像が undefined ならパートは 1 つ', req.contents[0].parts.length === 1);
  const req2 = buildAnalysisRequest(withRole, '本文', [] as any);
  check('画像が空の配列ならパートは 1 つ', req2.contents[0].parts.length === 1);
}

{
  const minutes = getAnalysisConfigForTest('minutes');
  check('minutes の設定を取得できる', !!minutes);
  check(
    'minutes の systemPrompt が想定した文と一致する',
    minutes?.systemPrompt === 'あなたは会議の議事録を作成する専門家です。与えられたデータから、重要な情報を構造化して整理します。',
    minutes?.systemPrompt
  );

  const research = getAnalysisConfigForTest('research');
  check('research の設定に systemPrompt がある', !!research?.systemPrompt);
  check('research の systemPrompt に役割の語が含まれる', !!research?.systemPrompt?.includes('情報調査の専門家'));

  for (const type of ['minutes', 'research']) {
    const cfg = getAnalysisConfigForTest(type);
    if (!cfg) continue;
    const req = buildAnalysisRequest(cfg, 'X');
    check(`${type}: systemPrompt を systemInstruction に入れる`, req.config.systemInstruction === cfg.systemPrompt);
    check(`${type}: contents は 1 件だけ`, req.contents.length === 1);
  }

  check('未定義の種類には undefined を返す', getAnalysisConfigForTest('no-such-type') === undefined);
}

console.log(`\n結果: ${pass} 成功 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);

export {};
