/**
 * 외부 API(구글 플라이트·Travelpayouts)에서 받은 글자를 화면에 넘기기 전에 정리한다
 * - 태그·따옴표·제어 문자를 빼고 길이를 자른다 (화면도 escape 하지만 한 번 더 막는다)
 */
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f<>"'`&]/g;

function cleanText(value, maxLength = 40) {
  return String(value ?? '').replace(UNSAFE_TEXT_PATTERN, '').trim().slice(0, maxLength);
}

module.exports = { cleanText };
