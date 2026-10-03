export const SHORTS_PROGRESS = [
  "유튜브 원본 영상 및 자막 다운로드 중...",
  "Gemini가 최고 흥미 구간 분석 중...",
  "9:16 세로 화면 크롭 및 줌/자막 렌더링 중...",
  "완성! 쇼츠 영상을 재생합니다.",
] as const;

export type ShortsStep = 1 | 2 | 3 | 4;

export function shortsMessage(step: ShortsStep): string {
  return SHORTS_PROGRESS[step - 1];
}
