// public/api/schedule.js
// public/api/slots.js 의 별칭(Alias) 엔드포인트
// 일부 광고차단기(uBlock, AdBlock 등)가 URL에 'slots'(카지노/슬롯머신 필터)가 포함된 요청을 차단(ERR_BLOCKED_BY_CLIENT)하는 것을 방지합니다.

const slotsHandler = require('./slots.js');

module.exports = async function handler(req, res) {
  return slotsHandler(req, res);
};
