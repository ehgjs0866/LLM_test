import type { OutputRequest } from '@deskpet/contracts';

/**
 * 출력 모델 지침 (출력 체인, 김도헌 담당).
 * 모델은 "고정 문구로 만든 기준 문장"을 자연스럽게 다시 쓰기만 한다. 새 사실을 만들지 않는다.
 * 외부 결과 원문·PR 내용·업무 설명 전체는 보내지 않고 기준 문장과 필수 토큰·상태만 보낸다 (데이터 최소화).
 * 모델 결과는 OutputService.validate가 다시 검사하고, 실패하면 기준 문장(고정 문구)을 그대로 쓴다.
 */
export const OUTPUT_PROMPT_VERSION = 'output-v1';

export const OUTPUT_INSTRUCTIONS = [
  `[${OUTPUT_PROMPT_VERSION}] 너는 책상 위 로봇 DeskPet의 안내 문장을 다듬는다.`,
  '입력의 "기준 문장"은 확인된 사실만으로 만든 정답 문장이다. 이를 짧고 자연스러운 한국어 존댓말로 다시 쓴다.',
  '규칙:',
  '1. "필수 포함" 항목은 글자 그대로 text와 displayText 모두에 넣는다.',
  '2. 기준 문장에 없는 사실, 숫자, 이름, 원인, 약속을 추가하지 않는다. 모르면 기준 문장을 거의 그대로 쓴다.',
  '3. 작업 상태가 succeeded가 아니면 "완료", "성공", "승인했어요", "반영했어요" 같은 완료 표현을 쓰지 않는다.',
  '4. 기준 문장이 질문이면 text도 질문으로 끝낸다.',
  '5. text는 음성으로 읽을 문장, displayText는 화면에 띄울 짧은 요약이다. 둘 다 최대 길이를 넘기지 않는다.',
  '6. emotion은 "허용 표정" 중 하나만 쓴다.',
].join('\n');

/** 모델 사용자 입력. 사실은 기준 문장으로만 전달한다 */
export function buildOutputPrompt(req: OutputRequest, base: { text: string; displayText: string }): string {
  return [
    `목적: ${req.purpose}`,
    `필수 포함: ${req.requiredMeaning.length ? req.requiredMeaning.join(' | ') : '(없음)'}`,
    `작업 상태: ${req.actionResults.length ? req.actionResults.map((a) => `${a.action}=${a.status}`).join(', ') : '(없음)'}`,
    `기준 문장: ${base.text}`,
    `기준 화면 문장: ${base.displayText}`,
    `허용 표정: ${req.constraints.allowedEmotions.join(', ')}`,
    `최대 길이: ${req.constraints.maxSpeechChars}자`,
  ].join('\n');
}
