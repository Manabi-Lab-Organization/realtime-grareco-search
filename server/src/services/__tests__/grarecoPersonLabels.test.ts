import { describe, it, expect } from 'vitest';
import { buildGrarecoInput, buildGrarecoPrompt, buildParticipantsSection } from '../grareco/grarecoPrompt.js';

const COMMON_SURNAMES = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田'];

describe('グラレコの人物に添える文字', () => {
  it('参加者が未登録なら、人名を考えず役割だけを書くよう指示する', () => {
    const prompt = buildGrarecoPrompt(buildGrarecoInput('【サマリー】\n・新商品の企画会議で、講師が受講者に進め方を説明した'), 0);
    expect(prompt).toContain('参加者情報が無いので、人名を考えて書き添えないでください');
    expect(prompt).toContain('役割（講師・受講者・上司・担当者など）だけ');
    expect(prompt).toContain('年齢・年代・性別・肩書などのプロフィールを、人物のラベルとして描き込まないでください');
    expect(prompt).not.toContain('名前（呼び名）だけ');
  });

  it('参加者が登録済みなら、人名は登録された名前だけにし、登録外の人物には役割だけを書くよう指示する', () => {
    const section = buildParticipantsSection([{ name: 'テスト 太郎', gender: '男', age: '30代' }]);
    const prompt = buildGrarecoPrompt(buildGrarecoInput(`${section}\n\n【サマリー】\n・新商品の企画会議`), 0);
    expect(prompt).toContain('人名を書いてよいのは、参加者情報に登録された名前だけです');
    expect(prompt).toContain('登録されていない人物には名前を考えて書き添えず');
    expect(section).toContain('人名を書いてよいのは、上の「名前」に登録された人だけです');
    expect(section).toContain('年齢・年代・性別・肩書などのプロフィールを書き添えないでください');
  });

  it('指示文に、禁止の例として具体的な名字を書かない', () => {
    const withoutParticipants = buildGrarecoPrompt(buildGrarecoInput('【サマリー】\n・新商品の企画会議'), 0);
    const section = buildParticipantsSection([{ name: 'テスト' }]);
    const withParticipants = buildGrarecoPrompt(buildGrarecoInput(`${section}\n\n【サマリー】\n・新商品の企画会議`), 0);
    for (const surname of COMMON_SURNAMES) {
      expect(withoutParticipants, surname).not.toContain(surname);
      expect(withParticipants, surname).not.toContain(surname);
    }
  });
});
