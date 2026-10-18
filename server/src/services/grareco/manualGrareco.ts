
import { buildGrarecoInput, buildGrarecoPrompt, type GrarecoInputOptions } from './grarecoPrompt.js';
import { buildGrarecoDraft, buildFinalDraftText, formatMeetingDate, type Participants } from './finalDraft.js';
import { generateGrarecoOpenAI } from './openaiImage.js';
import { notifyGrarecoFallback } from './grarecoFallbackAlert.js';
import type { GrarecoImageResult } from './imageOutput.js';

export type GrarecoProvider = 'openai' | 'gemini';

export function manualGrarecoProvider(): GrarecoProvider {
  if (process.env.GRARECO_MANUAL_PROVIDER === 'gemini' || !process.env.OPENAI_API_KEY) return 'gemini';
  return 'openai';
}

export async function generateManualGrareco(
  text: string,
  options: GrarecoInputOptions | undefined,
  generateWithGemini: (text: string, options?: GrarecoInputOptions) => Promise<GrarecoImageResult>,
  draft?: { summary?: string; material?: string; meetingDate?: Date; participants?: Participants; meetingType?: string | null },
): Promise<GrarecoImageResult> {
  if (manualGrarecoProvider() === 'gemini') {
    return generateWithGemini(text, options);
  }

  try {
    const pasted = draft?.material ?? text;
    const structured = await buildGrarecoDraft({
      summary: draft?.summary,
      pasted,
      material: buildGrarecoInput(pasted, options),
      meetingDate: draft?.meetingDate ? formatMeetingDate(draft.meetingDate) : undefined,
      participants: draft?.participants,
      meetingType: draft?.meetingType,
    });
    const draftText = buildFinalDraftText(structured);
    const prompt = buildGrarecoPrompt(draftText, 0);

    const out = await generateGrarecoOpenAI(prompt);
    return {
      imageUrl: out.imageUrl,
      modelUsed: out.modelUsed,
      costUsd: out.costUsd,
      imageDimensions: out.imageDimensions,
      refImagesUsed: 0,
      attempt: 1,
      imageQuality: out.quality,
      draftSections: structured.sections.length,
      draftKind: structured.kind,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[Grareco-Manual] OpenAI 経路が失敗したため Gemini にフォールバックします: ${reason}`);
    void notifyGrarecoFallback(reason);
    const result = await generateWithGemini(text, options);
    return { ...result, fallbackReason: reason.slice(0, 200) };
  }
}
