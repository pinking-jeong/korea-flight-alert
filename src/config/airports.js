/**
 * 대한민국 출발 공항(7곳) 및 전 세계 주요 국제선 취항지(60곳+) + 사용자 직접 입력(Custom) 지원 모듈
 */

const INDIVIDUAL_KOREAN_AIRPORTS = [
  { code: 'ICN', name: '인천국제공항', city: '서울/인천', badge: '최다 노선', originFactor: 1.0 },
  { code: 'GMP', name: '김포국제공항', city: '서울/김포', badge: '도심 근접', originFactor: 1.04 },
  { code: 'PUS', name: '김해국제공항', city: '부산/김해', badge: '영남권 허브', originFactor: 0.94 },
  { code: 'CJJ', name: '청주국제공항', city: '청주', badge: '충청권 LCC 특가', originFactor: 0.90 },
  { code: 'TAE', name: '대구국제공항', city: '대구', badge: '대경권 특가', originFactor: 0.92 },
  { code: 'CJU', name: '제주국제공항', city: '제주', badge: '제주 직항', originFactor: 0.96 },
  { code: 'MWX', name: '무안국제공항', city: '무안/광주', badge: '호남권 특가', originFactor: 0.91 }
];

const KOREAN_ORIGIN_AIRPORTS = [
  {
    code: 'ALL_KOREA',
    name: '대한민국 전체 공항 통합 (인천·김포·김해·청주·대구·제주·무안)',
    city: '🇰🇷 한국 전체 공항 통합',
    badge: '전국 7대 공항 최저가 자동선택',
    originFactor: 0.90,
    isAllKorea: true
  },
  ...INDIVIDUAL_KOREAN_AIRPORTS
];

const DEFAULT_AIRLINES_BY_REGION = {
  일본: [
    { code: '7C', name: '제주항공', baggage: '위탁 15kg 포함', outTime: '07:30 → 09:45', inTime: '15:00 → 17:20' },
    { code: 'ZE', name: '이스타항공', baggage: '위탁 15kg 포함', outTime: '08:10 → 10:25', inTime: '11:30 → 13:55' },
    { code: 'LJ', name: '진에어', baggage: '위탁 15kg 포함', outTime: '09:15 → 11:30', inTime: '16:20 → 18:45' },
    { code: 'TW', name: '티웨이항공', baggage: '위탁 15kg 포함', outTime: '10:20 → 12:35', inTime: '17:50 → 20:15' },
    { code: 'BX', name: '에어부산', baggage: '위탁 15kg 포함', outTime: '08:35 → 10:30', inTime: '14:15 → 16:15' },
    { code: 'KE', name: '대한항공', baggage: '위탁 23kg 포함', outTime: '09:00 → 11:15', inTime: '17:20 → 19:45' }
  ],
  동남아: [
    { code: '7C', name: '제주항공', baggage: '위탁 15kg 포함', outTime: '10:40 → 14:10', inTime: '15:10 → 22:15' },
    { code: 'LJ', name: '진에어', baggage: '위탁 15kg 포함', outTime: '19:50 → 23:30', inTime: '00:45 → 07:50' },
    { code: 'TW', name: '티웨이항공', baggage: '위탁 15kg 포함', outTime: '19:15 → 22:55', inTime: '00:15 → 07:20' },
    { code: 'VJ', name: '비엣젯항공', baggage: '기내 7kg 포함', outTime: '06:40 → 10:00', inTime: '23:20 → 05:50+1' },
    { code: 'YP', name: '에어프레미아', baggage: '위탁 23kg 포함', outTime: '17:10 → 21:10', inTime: '22:45 → 06:20+1' },
    { code: 'KE', name: '대한항공', baggage: '위탁 23kg 포함', outTime: '18:30 → 22:20', inTime: '23:45 → 07:05+1' }
  ],
  중화권: [
    { code: 'ZE', name: '이스타항공', baggage: '위탁 15kg 포함', outTime: '08:00 → 09:55', inTime: '11:00 → 14:35' },
    { code: '7C', name: '제주항공', baggage: '위탁 15kg 포함', outTime: '10:20 → 12:15', inTime: '13:20 → 16:55' },
    { code: 'TW', name: '티웨이항공', baggage: '위탁 15kg 포함', outTime: '09:10 → 11:05', inTime: '12:10 → 15:45' },
    { code: 'OZ', name: '아시아나항공', baggage: '위탁 23kg 포함', outTime: '09:50 → 11:45', inTime: '13:00 → 16:35' },
    { code: 'KE', name: '대한항공', baggage: '위탁 23kg 포함', outTime: '08:30 → 10:25', inTime: '11:40 → 15:15' }
  ],
  '미주/대양주': [
    { code: 'YP', name: '에어프레미아', baggage: '위탁 23kg x 2 포함', outTime: '13:30 → 08:40', inTime: '10:50 → 15:45+1' },
    { code: 'LJ', name: '진에어', baggage: '위탁 23kg 포함', outTime: '09:15 → 14:45', inTime: '16:15 → 19:50' },
    { code: 'TW', name: '티웨이항공', baggage: '위탁 23kg 포함', outTime: '21:30 → 09:45+1', inTime: '11:30 → 20:10' },
    { code: 'OZ', name: '아시아나항공', baggage: '위탁 23kg x 2 포함', outTime: '14:40 → 09:50', inTime: '12:10 → 17:10+1' },
    { code: 'KE', name: '대한항공', baggage: '위탁 23kg x 2 포함', outTime: '14:30 → 09:30', inTime: '11:30 → 16:30+1' }
  ],
  유럽: [
    { code: 'TW', name: '티웨이항공', baggage: '위탁 23kg 포함', outTime: '10:10 → 17:50', inTime: '20:10 → 15:20+1' },
    { code: 'YP', name: '에어프레미아', baggage: '위탁 23kg 포함', outTime: '11:05 → 16:50', inTime: '19:00 → 13:50+1' },
    { code: 'TK', name: '터키항공', baggage: '위탁 30kg 포함', outTime: '23:20 → 05:15+1', inTime: '01:40 → 17:55' },
    { code: 'OZ', name: '아시아나항공', baggage: '위탁 23kg 포함', outTime: '12:05 → 18:35', inTime: '20:55 → 15:55+1' },
    { code: 'KE', name: '대한항공', baggage: '위탁 23kg 포함', outTime: '11:50 → 18:20', inTime: '21:00 → 16:00+1' }
  ],
  기타: [
    { code: '7C', name: '제주항공', baggage: '위탁 15kg 포함', outTime: '09:00 → 12:30', inTime: '13:30 → 18:30' },
    { code: 'TW', name: '티웨이항공', baggage: '위탁 15kg 포함', outTime: '10:15 → 13:45', inTime: '14:45 → 19:45' },
    { code: 'KE', name: '대한항공', baggage: '위탁 23kg 포함', outTime: '11:00 → 14:30', inTime: '16:00 → 21:00' }
  ]
};

function makeDest({
  code,
  city,
  country,
  region,
  avg2YKrw,
  lowest2YKrw,
  top10Deal2YKrw,
  peakHigh2YKrw,
  flightDuration,
  cheapestMonths = ['5월', '6월', '9월', '11월'],
  peakMonths = ['7~8월 휴가철', '12~1월 연말연시', '명절 연휴'],
  priceTip,
  airlines
}) {
  const safeAvg = avg2YKrw || 320000;
  const safeLowest = lowest2YKrw || Math.round((safeAvg * 0.54) / 1000) * 1000;
  const safeTop10 = top10Deal2YKrw || Math.round((safeAvg * 0.72) / 1000) * 1000;
  const safePeak = peakHigh2YKrw || Math.round((safeAvg * 1.72) / 1000) * 1000;

  return {
    code: code.toUpperCase(),
    city,
    country,
    region,
    basePriceKrw: safeAvg,
    dealThresholdKrw: safeTop10,
    flightDuration: flightDuration || '4시간 00분',
    benchmark2Y: {
      lowest2YKrw: safeLowest,
      top10Deal2YKrw: safeTop10,
      avg2YKrw: safeAvg,
      peakHigh2YKrw: safePeak,
      outboundAvgOneWayKrw: Math.round((safeAvg * 0.49) / 1000) * 1000,
      inboundAvgOneWayKrw: Math.round((safeAvg * 0.51) / 1000) * 1000,
      cheapestMonths,
      peakMonths,
      priceTip:
        priceTip ||
        `${city}(${code}) 노선은 출국 편도와 귀국 편도를 서로 다른 항공사로 분리 탐색해 합산할 때 왕복 묶음 대비 평균 12~18% 저렴합니다.`
    },
    airlines: airlines || DEFAULT_AIRLINES_BY_REGION[region] || DEFAULT_AIRLINES_BY_REGION['기타']
  };
}

const INTERNATIONAL_DESTINATIONS = [
  // ================= 일본 (15개 도시) =================
  makeDest({
    code: 'NRT',
    city: '도쿄 (나리타)',
    country: '일본',
    region: '일본',
    avg2YKrw: 268000,
    lowest2YKrw: 149000,
    top10Deal2YKrw: 195000,
    peakHigh2YKrw: 465000,
    flightDuration: '2시간 25분',
    cheapestMonths: ['5월', '6월', '9월', '11월'],
    peakMonths: ['3~4월 벚꽃철', '7~8월', '연말연시'],
    priceTip: '출국편은 오전 LCC(이스타/제주항공), 귀국편은 수하물 23kg이 포함된 에어프레미아 편도 조합이 가장 유리합니다.'
  }),
  makeDest({
    code: 'HND',
    city: '도쿄 (하네다)',
    country: '일본',
    region: '일본',
    avg2YKrw: 355000,
    lowest2YKrw: 218000,
    top10Deal2YKrw: 269000,
    peakHigh2YKrw: 540000,
    flightDuration: '2시간 15분',
    cheapestMonths: ['5월', '6월', '11월'],
    priceTip: '인천↔하네다 피치항공 편도와 김포↔하네다 국적기 편도를 교차 조합하면 도심 접근성과 가성비를 모두 잡을 수 있습니다.'
  }),
  makeDest({
    code: 'KIX',
    city: '오사카 (간사이)',
    country: '일본',
    region: '일본',
    avg2YKrw: 224000,
    lowest2YKrw: 124000,
    top10Deal2YKrw: 165000,
    peakHigh2YKrw: 390000,
    flightDuration: '1시간 50분',
    priceTip: '취항 LCC가 8개 이상이므로 출국(오전 제주/이스타)과 귀국(오후 피치/티웨이/에어부산) 편도 조합 시 평균 18% 저렴합니다.'
  }),
  makeDest({
    code: 'FUK',
    city: '후쿠오카',
    country: '일본',
    region: '일본',
    avg2YKrw: 192000,
    lowest2YKrw: 98000,
    top10Deal2YKrw: 138000,
    peakHigh2YKrw: 335000,
    flightDuration: '1시간 25분',
    priceTip: '화/수 출발 ~ 목/금 귀국 편도 조합 시 왕복 합산 10만 원대 초반 발권이 가장 자주 나오는 초단거리 노선입니다.'
  }),
  makeDest({
    code: 'CTS',
    city: '삿포로 (신치토세)',
    country: '일본',
    region: '일본',
    avg2YKrw: 378000,
    lowest2YKrw: 199000,
    top10Deal2YKrw: 265000,
    peakHigh2YKrw: 690000,
    flightDuration: '2시간 50분',
    cheapestMonths: ['4월', '5월', '10월', '11월'],
    peakMonths: ['12~2월 눈축제', '7~8월 라벤더 시즌']
  }),
  makeDest({
    code: 'OKA',
    city: '오키나와 (나하)',
    country: '일본',
    region: '일본',
    avg2YKrw: 285000,
    lowest2YKrw: 158000,
    top10Deal2YKrw: 205000,
    peakHigh2YKrw: 495000,
    flightDuration: '2시간 15분',
    cheapestMonths: ['3월', '4월', '11월', '12월 초']
  }),
  makeDest({
    code: 'NGO',
    city: '나고야 (주부)',
    country: '일본',
    region: '일본',
    avg2YKrw: 238000,
    lowest2YKrw: 135000,
    top10Deal2YKrw: 175000,
    peakHigh2YKrw: 395000,
    flightDuration: '1시간 55분'
  }),
  makeDest({
    code: 'TAK',
    city: '다카마쓰 (소도시)',
    country: '일본',
    region: '일본',
    avg2YKrw: 215000,
    lowest2YKrw: 118000,
    top10Deal2YKrw: 155000,
    peakHigh2YKrw: 350000,
    flightDuration: '1시간 40분',
    priceTip: '에어서울·진에어 프로모션 편도 조합 시 무료 쿠폰북 혜택과 함께 10만 원대 중반 발권이 가능합니다.'
  }),
  makeDest({
    code: 'MYJ',
    city: '마쓰야마 (소도시)',
    country: '일본',
    region: '일본',
    avg2YKrw: 218000,
    lowest2YKrw: 119000,
    top10Deal2YKrw: 158000,
    peakHigh2YKrw: 360000,
    flightDuration: '1시간 35분',
    priceTip: '제주항공 취항 노선으로 한국인 전용 무료 공항 리무진 버스가 제공되는 가성비 온천 여행지입니다.'
  }),
  makeDest({
    code: 'FSZ',
    city: '시즈오카 (후지산)',
    country: '일본',
    region: '일본',
    avg2YKrw: 229000,
    lowest2YKrw: 128000,
    top10Deal2YKrw: 168000,
    peakHigh2YKrw: 380000,
    flightDuration: '2시간 00분'
  }),
  makeDest({
    code: 'KMJ',
    city: '구마모토',
    country: '일본',
    region: '일본',
    avg2YKrw: 212000,
    lowest2YKrw: 115000,
    top10Deal2YKrw: 152000,
    peakHigh2YKrw: 355000,
    flightDuration: '1시간 30분'
  }),
  makeDest({
    code: 'OIT',
    city: '오이타 (벳푸/유후인)',
    country: '일본',
    region: '일본',
    avg2YKrw: 219000,
    lowest2YKrw: 122000,
    top10Deal2YKrw: 159000,
    peakHigh2YKrw: 365000,
    flightDuration: '1시간 35분'
  }),
  makeDest({
    code: 'KOJ',
    city: '가고시마',
    country: '일본',
    region: '일본',
    avg2YKrw: 225000,
    lowest2YKrw: 126000,
    top10Deal2YKrw: 164000,
    peakHigh2YKrw: 375000,
    flightDuration: '1시간 40분'
  }),
  makeDest({
    code: 'YGJ',
    city: '요나고 (돗토리)',
    country: '일본',
    region: '일본',
    avg2YKrw: 214000,
    lowest2YKrw: 116000,
    top10Deal2YKrw: 154000,
    peakHigh2YKrw: 350000,
    flightDuration: '1시간 30분'
  }),
  makeDest({
    code: 'HIJ',
    city: '히로시마',
    country: '일본',
    region: '일본',
    avg2YKrw: 216000,
    lowest2YKrw: 118000,
    top10Deal2YKrw: 156000,
    peakHigh2YKrw: 355000,
    flightDuration: '1시간 35분'
  }),

  // ================= 동남아 (18개 도시) =================
  makeDest({
    code: 'DAD',
    city: '다낭',
    country: '베트남',
    region: '동남아',
    avg2YKrw: 325000,
    lowest2YKrw: 178000,
    top10Deal2YKrw: 235000,
    peakHigh2YKrw: 560000,
    flightDuration: '4시간 45분'
  }),
  makeDest({
    code: 'CXR',
    city: '나트랑 (깜라인)',
    country: '베트남',
    region: '동남아',
    avg2YKrw: 342000,
    lowest2YKrw: 189000,
    top10Deal2YKrw: 248000,
    peakHigh2YKrw: 585000,
    flightDuration: '5시간 05분'
  }),
  makeDest({
    code: 'PQC',
    city: '푸꾸옥',
    country: '베트남',
    region: '동남아',
    avg2YKrw: 368000,
    lowest2YKrw: 198000,
    top10Deal2YKrw: 265000,
    peakHigh2YKrw: 620000,
    flightDuration: '5시간 30분',
    priceTip: '이스타항공·제주항공·비엣젯 직항 편도를 교차 조합하면 20만 원대 초반으로 푸꾸옥 직항 왕복이 가능합니다.'
  }),
  makeDest({
    code: 'HAN',
    city: '하노이',
    country: '베트남',
    region: '동남아',
    avg2YKrw: 308000,
    lowest2YKrw: 169000,
    top10Deal2YKrw: 222000,
    peakHigh2YKrw: 520000,
    flightDuration: '4시간 30분'
  }),
  makeDest({
    code: 'SGN',
    city: '호치민',
    country: '베트남',
    region: '동남아',
    avg2YKrw: 332000,
    lowest2YKrw: 184000,
    top10Deal2YKrw: 239000,
    peakHigh2YKrw: 565000,
    flightDuration: '5시간 20분'
  }),
  makeDest({
    code: 'DLI',
    city: '달랏',
    country: '베트남',
    region: '동남아',
    avg2YKrw: 348000,
    lowest2YKrw: 192000,
    top10Deal2YKrw: 252000,
    peakHigh2YKrw: 580000,
    flightDuration: '5시간 05분'
  }),
  makeDest({
    code: 'BKK',
    city: '방콕 (수완나품)',
    country: '태국',
    region: '동남아',
    avg2YKrw: 398000,
    lowest2YKrw: 229000,
    top10Deal2YKrw: 285000,
    peakHigh2YKrw: 680000,
    flightDuration: '5시간 45분'
  }),
  makeDest({
    code: 'CNX',
    city: '치앙마이',
    country: '태국',
    region: '동남아',
    avg2YKrw: 425000,
    lowest2YKrw: 238000,
    top10Deal2YKrw: 305000,
    peakHigh2YKrw: 710000,
    flightDuration: '5시간 50분',
    cheapestMonths: ['5월', '6월', '9월', '10월']
  }),
  makeDest({
    code: 'HKT',
    city: '푸껫',
    country: '태국',
    region: '동남아',
    avg2YKrw: 445000,
    lowest2YKrw: 254000,
    top10Deal2YKrw: 322000,
    peakHigh2YKrw: 740000,
    flightDuration: '6시간 20분'
  }),
  makeDest({
    code: 'CEB',
    city: '세부',
    country: '필리핀',
    region: '동남아',
    avg2YKrw: 285000,
    lowest2YKrw: 145000,
    top10Deal2YKrw: 195000,
    peakHigh2YKrw: 490000,
    flightDuration: '4시간 35분'
  }),
  makeDest({
    code: 'TAG',
    city: '보홀 (팡라오)',
    country: '필리핀',
    region: '동남아',
    avg2YKrw: 328000,
    lowest2YKrw: 179000,
    top10Deal2YKrw: 235000,
    peakHigh2YKrw: 550000,
    flightDuration: '4시간 40분'
  }),
  makeDest({
    code: 'MNL',
    city: '마닐라',
    country: '필리핀',
    region: '동남아',
    avg2YKrw: 255000,
    lowest2YKrw: 132000,
    top10Deal2YKrw: 182000,
    peakHigh2YKrw: 440000,
    flightDuration: '4시간 05분'
  }),
  makeDest({
    code: 'CRK',
    city: '클락 (앙헬레스)',
    country: '필리핀',
    region: '동남아',
    avg2YKrw: 262000,
    lowest2YKrw: 138000,
    top10Deal2YKrw: 188000,
    peakHigh2YKrw: 450000,
    flightDuration: '4시간 00분'
  }),
  makeDest({
    code: 'KLO',
    city: '보라카이 (칼리보)',
    country: '필리핀',
    region: '동남아',
    avg2YKrw: 298000,
    lowest2YKrw: 159000,
    top10Deal2YKrw: 215000,
    peakHigh2YKrw: 510000,
    flightDuration: '4시간 25분'
  }),
  makeDest({
    code: 'SIN',
    city: '싱가포르 (창이)',
    country: '싱가포르',
    region: '동남아',
    avg2YKrw: 435000,
    lowest2YKrw: 249000,
    top10Deal2YKrw: 315000,
    peakHigh2YKrw: 720000,
    flightDuration: '6시간 20분'
  }),
  makeDest({
    code: 'BKI',
    city: '코타키나발루',
    country: '말레이시아',
    region: '동남아',
    avg2YKrw: 338000,
    lowest2YKrw: 182000,
    top10Deal2YKrw: 242000,
    peakHigh2YKrw: 570000,
    flightDuration: '5시간 15분'
  }),
  makeDest({
    code: 'KUL',
    city: '쿠알라룸푸르',
    country: '말레이시아',
    region: '동남아',
    avg2YKrw: 385000,
    lowest2YKrw: 212000,
    top10Deal2YKrw: 278000,
    peakHigh2YKrw: 640000,
    flightDuration: '6시간 30분'
  }),
  makeDest({
    code: 'DPS',
    city: '발리 (덴파사르)',
    country: '인도네시아',
    region: '동남아',
    avg2YKrw: 610000,
    lowest2YKrw: 368000,
    top10Deal2YKrw: 445000,
    peakHigh2YKrw: 980000,
    flightDuration: '7시간 10분'
  }),
  makeDest({
    code: 'VTE',
    city: '비엔티안',
    country: '라오스',
    region: '동남아',
    avg2YKrw: 365000,
    lowest2YKrw: 199000,
    top10Deal2YKrw: 262000,
    peakHigh2YKrw: 610000,
    flightDuration: '5시간 10분'
  }),

  // ================= 중화권 / 몽골 / 중앙아시아 (12개 도시) =================
  makeDest({
    code: 'TPE',
    city: '타이베이 (타오위안)',
    country: '대만',
    region: '중화권',
    avg2YKrw: 248000,
    lowest2YKrw: 132000,
    top10Deal2YKrw: 175000,
    peakHigh2YKrw: 420000,
    flightDuration: '2시간 40분'
  }),
  makeDest({
    code: 'KHH',
    city: '가오슝',
    country: '대만',
    region: '중화권',
    avg2YKrw: 235000,
    lowest2YKrw: 125000,
    top10Deal2YKrw: 169000,
    peakHigh2YKrw: 395000,
    flightDuration: '2시간 55분'
  }),
  makeDest({
    code: 'RMQ',
    city: '타이중',
    country: '대만',
    region: '중화권',
    avg2YKrw: 239000,
    lowest2YKrw: 129000,
    top10Deal2YKrw: 172000,
    peakHigh2YKrw: 400000,
    flightDuration: '2시간 45분'
  }),
  makeDest({
    code: 'HKG',
    city: '홍콩',
    country: '홍콩',
    region: '중화권',
    avg2YKrw: 305000,
    lowest2YKrw: 159000,
    top10Deal2YKrw: 215000,
    peakHigh2YKrw: 510000,
    flightDuration: '3시간 45분'
  }),
  makeDest({
    code: 'MFM',
    city: '마카오',
    country: '마카오',
    region: '중화권',
    avg2YKrw: 278000,
    lowest2YKrw: 148000,
    top10Deal2YKrw: 198000,
    peakHigh2YKrw: 470000,
    flightDuration: '3시간 50분'
  }),
  makeDest({
    code: 'PVG',
    city: '상하이 (푸동)',
    country: '중국',
    region: '중화권',
    avg2YKrw: 215000,
    lowest2YKrw: 118000,
    top10Deal2YKrw: 155000,
    peakHigh2YKrw: 370000,
    flightDuration: '2시간 05분',
    priceTip: '중국 무비자 입국 시행 이후 상하이 노선은 이스타·춘추·동방항공 편도 조합 시 10만 원대 초중반 발권이 가능합니다.'
  }),
  makeDest({
    code: 'PEK',
    city: '베이징 (수도)',
    country: '중국',
    region: '중화권',
    avg2YKrw: 232000,
    lowest2YKrw: 128000,
    top10Deal2YKrw: 168000,
    peakHigh2YKrw: 390000,
    flightDuration: '2시간 10분'
  }),
  makeDest({
    code: 'TAO',
    city: '칭다오 (청도)',
    country: '중국',
    region: '중화권',
    avg2YKrw: 168000,
    lowest2YKrw: 94000,
    top10Deal2YKrw: 122000,
    peakHigh2YKrw: 290000,
    flightDuration: '1시간 30분',
    priceTip: '한국에서 가장 저렴한 해외 노선 중 하나로 평일 편도 조합 시 유류세 포함 10만 원 안팎으로 왕복 가능합니다.'
  }),
  makeDest({
    code: 'DYG',
    city: '장가계',
    country: '중국',
    region: '중화권',
    avg2YKrw: 395000,
    lowest2YKrw: 225000,
    top10Deal2YKrw: 285000,
    peakHigh2YKrw: 650000,
    flightDuration: '3시간 30분'
  }),
  makeDest({
    code: 'UBN',
    city: '울란바토르',
    country: '몽골',
    region: '중화권',
    avg2YKrw: 420000,
    lowest2YKrw: 228000,
    top10Deal2YKrw: 298000,
    peakHigh2YKrw: 760000,
    flightDuration: '3시간 40분',
    cheapestMonths: ['4월', '5월', '9월', '10월']
  }),
  makeDest({
    code: 'ALA',
    city: '알마티',
    country: '카자흐스탄',
    region: '중화권',
    avg2YKrw: 580000,
    lowest2YKrw: 345000,
    top10Deal2YKrw: 425000,
    peakHigh2YKrw: 920000,
    flightDuration: '6시간 45분'
  }),

  // ================= 미주 / 하와이 / 대양주 (12개 도시) =================
  makeDest({
    code: 'GUM',
    city: '괌',
    country: '미국(령)',
    region: '미주/대양주',
    avg2YKrw: 355000,
    lowest2YKrw: 198000,
    top10Deal2YKrw: 255000,
    peakHigh2YKrw: 620000,
    flightDuration: '4시간 30분'
  }),
  makeDest({
    code: 'SPN',
    city: '사이판',
    country: '미국(령)',
    region: '미주/대양주',
    avg2YKrw: 348000,
    lowest2YKrw: 192000,
    top10Deal2YKrw: 249000,
    peakHigh2YKrw: 595000,
    flightDuration: '4시간 25분'
  }),
  makeDest({
    code: 'HNL',
    city: '하와이 (호놀룰루)',
    country: '미국',
    region: '미주/대양주',
    avg2YKrw: 920000,
    lowest2YKrw: 589000,
    top10Deal2YKrw: 698000,
    peakHigh2YKrw: 1520000,
    flightDuration: '8시간 15분',
    priceTip: '에어프레미아·하와이안항공·대한항공 편도를 비교해 조합하면 60만 원대 하와이 직항이 가능합니다.'
  }),
  makeDest({
    code: 'SYD',
    city: '시드니',
    country: '호주',
    region: '미주/대양주',
    avg2YKrw: 870000,
    lowest2YKrw: 549000,
    top10Deal2YKrw: 669000,
    peakHigh2YKrw: 1450000,
    flightDuration: '10시간 20분'
  }),
  makeDest({
    code: 'MEL',
    city: '멜버른',
    country: '호주',
    region: '미주/대양주',
    avg2YKrw: 910000,
    lowest2YKrw: 579000,
    top10Deal2YKrw: 695000,
    peakHigh2YKrw: 1490000,
    flightDuration: '10시간 35분'
  }),
  makeDest({
    code: 'BNE',
    city: '브리즈번',
    country: '호주',
    region: '미주/대양주',
    avg2YKrw: 840000,
    lowest2YKrw: 529000,
    top10Deal2YKrw: 645000,
    peakHigh2YKrw: 1390000,
    flightDuration: '9시간 50분'
  }),
  makeDest({
    code: 'AKL',
    city: '오클랜드',
    country: '뉴질랜드',
    region: '미주/대양주',
    avg2YKrw: 1120000,
    lowest2YKrw: 740000,
    top10Deal2YKrw: 865000,
    peakHigh2YKrw: 1780000,
    flightDuration: '11시간 15분'
  }),
  makeDest({
    code: 'LAX',
    city: '로스앤젤레스 (LA)',
    country: '미국',
    region: '미주/대양주',
    avg2YKrw: 1090000,
    lowest2YKrw: 698000,
    top10Deal2YKrw: 839000,
    peakHigh2YKrw: 1790000,
    flightDuration: '11시간 10분'
  }),
  makeDest({
    code: 'SFO',
    city: '샌프란시스코',
    country: '미국',
    region: '미주/대양주',
    avg2YKrw: 1060000,
    lowest2YKrw: 679000,
    top10Deal2YKrw: 819000,
    peakHigh2YKrw: 1740000,
    flightDuration: '10시간 40분'
  }),
  makeDest({
    code: 'JFK',
    city: '뉴욕 (JFK/뉴어크)',
    country: '미국',
    region: '미주/대양주',
    avg2YKrw: 1320000,
    lowest2YKrw: 849000,
    top10Deal2YKrw: 998000,
    peakHigh2YKrw: 2150000,
    flightDuration: '14시간 10분'
  }),
  makeDest({
    code: 'SEA',
    city: '시애틀',
    country: '미국',
    region: '미주/대양주',
    avg2YKrw: 1080000,
    lowest2YKrw: 695000,
    top10Deal2YKrw: 829000,
    peakHigh2YKrw: 1750000,
    flightDuration: '10시간 15분'
  }),
  makeDest({
    code: 'YVR',
    city: '밴쿠버',
    country: '캐나다',
    region: '미주/대양주',
    avg2YKrw: 1040000,
    lowest2YKrw: 659000,
    top10Deal2YKrw: 798000,
    peakHigh2YKrw: 1690000,
    flightDuration: '10시간 05분'
  }),

  // ================= 유럽 / 중동 (13개 도시) =================
  makeDest({
    code: 'CDG',
    city: '파리 (샤를드골)',
    country: '프랑스',
    region: '유럽',
    avg2YKrw: 1030000,
    lowest2YKrw: 649000,
    top10Deal2YKrw: 779000,
    peakHigh2YKrw: 1680000,
    flightDuration: '13시간 50분'
  }),
  makeDest({
    code: 'LHR',
    city: '런던 (히드로)',
    country: '영국',
    region: '유럽',
    avg2YKrw: 1180000,
    lowest2YKrw: 749000,
    top10Deal2YKrw: 895000,
    peakHigh2YKrw: 1890000,
    flightDuration: '14시간 15분'
  }),
  makeDest({
    code: 'FRA',
    city: '프랑크푸르트',
    country: '독일',
    region: '유럽',
    avg2YKrw: 990000,
    lowest2YKrw: 629000,
    top10Deal2YKrw: 749000,
    peakHigh2YKrw: 1620000,
    flightDuration: '13시간 30분'
  }),
  makeDest({
    code: 'FCO',
    city: '로마 (피우미치노)',
    country: '이탈리아',
    region: '유럽',
    avg2YKrw: 1010000,
    lowest2YKrw: 639000,
    top10Deal2YKrw: 769000,
    peakHigh2YKrw: 1650000,
    flightDuration: '13시간 40분'
  }),
  makeDest({
    code: 'BCN',
    city: '바르셀로나',
    country: '스페인',
    region: '유럽',
    avg2YKrw: 1060000,
    lowest2YKrw: 669000,
    top10Deal2YKrw: 799000,
    peakHigh2YKrw: 1720000,
    flightDuration: '14시간 10분'
  }),
  makeDest({
    code: 'MAD',
    city: '마드리드',
    country: '스페인',
    region: '유럽',
    avg2YKrw: 1080000,
    lowest2YKrw: 685000,
    top10Deal2YKrw: 815000,
    peakHigh2YKrw: 1750000,
    flightDuration: '14시간 20분'
  }),
  makeDest({
    code: 'PRG',
    city: '프라하',
    country: '체코',
    region: '유럽',
    avg2YKrw: 1090000,
    lowest2YKrw: 695000,
    top10Deal2YKrw: 829000,
    peakHigh2YKrw: 1780000,
    flightDuration: '13시간 10분'
  }),
  makeDest({
    code: 'VIE',
    city: '비엔나 (빈)',
    country: '오스트리아',
    region: '유럽',
    avg2YKrw: 1070000,
    lowest2YKrw: 679000,
    top10Deal2YKrw: 815000,
    peakHigh2YKrw: 1740000,
    flightDuration: '13시간 05분'
  }),
  makeDest({
    code: 'BUD',
    city: '부다페스트',
    country: '헝가리',
    region: '유럽',
    avg2YKrw: 1050000,
    lowest2YKrw: 665000,
    top10Deal2YKrw: 795000,
    peakHigh2YKrw: 1710000,
    flightDuration: '13시간 00분'
  }),
  makeDest({
    code: 'ZRH',
    city: '취리히',
    country: '스위스',
    region: '유럽',
    avg2YKrw: 1190000,
    lowest2YKrw: 759000,
    top10Deal2YKrw: 899000,
    peakHigh2YKrw: 1920000,
    flightDuration: '13시간 50분'
  }),
  makeDest({
    code: 'IST',
    city: '이스탄불',
    country: '튀르키예',
    region: '유럽',
    avg2YKrw: 940000,
    lowest2YKrw: 589000,
    top10Deal2YKrw: 715000,
    peakHigh2YKrw: 1540000,
    flightDuration: '11시간 45분'
  }),
  makeDest({
    code: 'ZAG',
    city: '자그레브',
    country: '크로아티아',
    region: '유럽',
    avg2YKrw: 1020000,
    lowest2YKrw: 645000,
    top10Deal2YKrw: 775000,
    peakHigh2YKrw: 1660000,
    flightDuration: '13시간 15분'
  }),
  makeDest({
    code: 'DXB',
    city: '두바이',
    country: '아랍에미리트',
    region: '유럽',
    avg2YKrw: 920000,
    lowest2YKrw: 579000,
    top10Deal2YKrw: 699000,
    peakHigh2YKrw: 1490000,
    flightDuration: '9시간 55분'
  })
];

function getOriginByCode(code) {
  const cleanCode = String(code || 'ICN').trim().toUpperCase();
  if (cleanCode === 'ALL' || cleanCode === 'KR' || cleanCode === 'KOREA') {
    return KOREAN_ORIGIN_AIRPORTS[0]; // ALL_KOREA
  }
  return KOREAN_ORIGIN_AIRPORTS.find((a) => a.code === cleanCode) || {
    code: cleanCode,
    name: `${cleanCode} 공항`,
    city: cleanCode,
    badge: '직접 입력 공항',
    originFactor: 1.0
  };
}

/**
 * 도착지(권역/공항코드)별로 대한민국 내 취항 가능한 출발 공항 목록 반환 (ALL_KOREA 통합 스캔용)
 */
function getEligibleKoreanOriginsForDestination(destMeta = {}) {
  const code = (destMeta.code || '').toUpperCase();
  const region = destMeta.region || '기타';

  // 도심 공항 전용 노선 (하네다, 송산, 홍차오)
  if (['HND', 'TSA', 'SHA'].includes(code)) {
    return INDIVIDUAL_KOREAN_AIRPORTS.filter((a) => ['GMP', 'ICN'].includes(a.code));
  }
  // 장거리(유럽, 미주/대양주 중 본토)
  if (region === '유럽' || (region === '미주/대양주' && !['GUM', 'SPN'].includes(code))) {
    return INDIVIDUAL_KOREAN_AIRPORTS.filter((a) => a.code === 'ICN');
  }
  // 괌/사이판
  if (['GUM', 'SPN'].includes(code)) {
    return INDIVIDUAL_KOREAN_AIRPORTS.filter((a) => ['ICN', 'PUS'].includes(a.code));
  }
  // 일본/중화권/동남아 주요 대도시 및 인기 휴양지는 지방공항(김해·청주·대구·제주·무안) 직항 취항 활발
  const regionalDirectHubs = [
    'FUK', 'KIX', 'NRT', 'CTS', 'OKA', 'NGO', 'KMJ', 'MYJ',
    'TPE', 'KHH', 'TAO', 'YNT', 'HKG', 'MFM', 'DYG', 'PVG', 'PEK', 'UBN',
    'DAD', 'CXR', 'PQC', 'HAN', 'SGN', 'BKK', 'CNX', 'CEB', 'MNL', 'CRK', 'KLO', 'BKI', 'VTE', 'SIN'
  ];
  if (regionalDirectHubs.includes(code)) {
    return INDIVIDUAL_KOREAN_AIRPORTS.filter((a) =>
      ['ICN', 'PUS', 'CJJ', 'TAE', 'CJU', 'MWX', ...(code === 'KIX' || code === 'PEK' ? ['GMP'] : [])].includes(a.code)
    );
  }
  // 기타 일본/동남아/중화권 소도시
  return INDIVIDUAL_KOREAN_AIRPORTS.filter((a) => ['ICN', 'PUS', 'CJJ'].includes(a.code));
}

/**
 * 기본 70여 개 도시 + 사용자 직접 등록(customDestinations) 또는 임의 입력된 공항 코드/도시명 자동 해석
 */
function getDestinationByCode(code, customDestinations = [], customCityName = '') {
  const cleanCode = String(code || 'NRT').trim().toUpperCase();
  const preset = INTERNATIONAL_DESTINATIONS.find((d) => d.code === cleanCode);
  if (preset) return preset;

  const customFound = (customDestinations || []).find((d) => d.code === cleanCode);
  if (customFound) return customFound;

  // 목록에 없는 새로운 공항 코드가 직접 입력된 경우에도 즉시 2년 벤치마크 및 편도 탐색이 작동하도록 동적 생성
  return makeDest({
    code: cleanCode,
    city: customCityName ? `${customCityName}` : `${cleanCode} (직접입력 도시)`,
    country: '사용자 지정',
    region: '기타',
    avg2YKrw: 420000,
    lowest2YKrw: 245000,
    top10Deal2YKrw: 315000,
    peakHigh2YKrw: 720000,
    flightDuration: '직접 입력 노선'
  });
}

function calculatePassengerPricing(adultUnitPriceKrw, { adults = 1, children = 0, infants = 0 } = {}) {
  const safeAdults = Math.max(1, Number(adults) || 1);
  const safeChildren = Math.max(0, Number(children) || 0);
  const safeInfants = Math.max(0, Math.min(safeAdults, Number(infants) || 0));

  const adultFare = Math.round(adultUnitPriceKrw);
  const childFare = Math.round((adultUnitPriceKrw * 0.8) / 100) * 100;
  const infantFare = Math.round((adultUnitPriceKrw * 0.1) / 100) * 100;

  const totalKrw = safeAdults * adultFare + safeChildren * childFare + safeInfants * infantFare;

  const parts = [`성인 ${safeAdults}명`];
  if (safeChildren > 0) parts.push(`소아 ${safeChildren}명`);
  if (safeInfants > 0) parts.push(`유아 ${safeInfants}명`);

  return {
    adults: safeAdults,
    children: safeChildren,
    infants: safeInfants,
    adultUnitPriceKrw: adultFare,
    childUnitPriceKrw: childFare,
    infantUnitPriceKrw: infantFare,
    totalPassengersPriceKrw: totalKrw,
    passengerSummaryText: parts.join(' · ')
  };
}

const AIRLINE_OFFICIAL_URLS = {
  '제주항공': 'https://www.jejuair.net/ko/main/base/index.do',
  '진에어': 'https://www.jinair.com/booking/index',
  '티웨이항공': 'https://www.twayair.com/app/main',
  '에어부산': 'https://www.airbusan.com/content/individual/',
  '에어서울': 'https://flyairseoul.com/CW/ko/main.do',
  '이스타항공': 'https://www.eastarjet.com/',
  '에어프레미아': 'https://www.airpremia.com/kr/ko',
  '에어로케이': 'https://www.aerok.com/',
  '대한항공': 'https://www.koreanair.com/',
  '아시아나항공': 'https://flyasiana.com/',
  '피치항공': 'https://www.flypeach.com/kr',
  '집에어(ZIPAIR)': 'https://www.zipair.net/ko',
  '비엣젯항공': 'https://www.vietjetair.com/ko',
  '베트남항공': 'https://www.vietnamairlines.com/kr/ko/home',
  '세부퍼시픽': 'https://www.cebupacificair.com/ko-kr',
  '필리핀항공': 'https://www.philippineairlines.com/kr/ko',
  '에어아시아': 'https://www.airasia.com/ko/kr',
  '스쿠트항공': 'https://www.flyscoot.com/kr',
  '싱가포르항공': 'https://www.singaporeair.com/ko_KR/kr/home',
  '타이항공': 'https://www.thaiairways.com/ko_KR/index.page',
  '중화항공': 'https://www.china-airlines.com/kr/ko',
  '에바항공': 'https://www.evaair.com/ko-kr/index.html',
  '타이거에어 타이완': 'https://www.tigerairtw.com/ko',
  '캐세이퍼시픽': 'https://www.cathaypacific.com/cx/ko_KR.html',
  '홍콩익스프레스': 'https://www.hkexpress.com/ko',
  '에어마카오': 'https://www.airmacau.co.kr/',
  '산동항공': 'https://www.sda.cn/',
  '중국동방항공': 'https://kr.ceair.com/ko/',
  '중국남방항공': 'https://www.csair.com/kr/ko/',
  '춘추항공': 'https://kr.ch.com/',
  '몽골항공(MIAT)': 'https://www.miat.com/',
  '에미레이트항공': 'https://www.emirates.com/kr/korean/',
  '카타르항공': 'https://www.qatarairways.com/ko-kr/homepage.html',
  '에티하드항공': 'https://www.etihad.com/ko-kr',
  '터키항공': 'https://www.turkishairlines.com/ko-int/',
  '루프트한자': 'https://www.lufthansa.com/kr/ko/homepage',
  '에어프랑스': 'https://wwws.airfrance.co.kr/',
  'KLM 네덜란드항공': 'https://www.klm.co.kr/',
  '핀에어': 'https://www.finnair.com/kr-ko',
  '폴란드항공(LOT)': 'https://www.lot.com/kr/ko',
  '유나이티드항공': 'https://www.united.com/ko/kr',
  '델타항공': 'https://ko.delta.com/',
  '아메리칸항공': 'https://www.americanairlines.co.kr/',
  '하와이안항공': 'https://www.hawaiianairlines.co.kr/',
  '에어캐나다': 'https://www.aircanada.com/kr/ko/aco/home.html',
  '젯스타(Jetstar)': 'https://www.jetstar.com/kr/ko/home',
  '콴타스항공': 'https://www.qantas.com/kr/en.html'
};

function getAirlineOfficialBookingUrl(airlineName = '') {
  if (!airlineName) return 'https://flight.naver.com/';
  for (const [key, url] of Object.entries(AIRLINE_OFFICIAL_URLS)) {
    if (airlineName.includes(key) || key.includes(airlineName)) {
      return url;
    }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(airlineName + ' 공식 홈페이지 항공권 예약')}`;
}

function buildBookingLinks({
  origin,
  destination,
  departureDate,
  returnDate,
  adults = 1,
  children = 0,
  infants = 0,
  directOnly = true,
  outboundAirline = '',
  inboundAirline = ''
}) {
  // ALL_KOREA 인 경우 실제 예약 가능한 3자리 공항 코드(기본 ICN)로 안전 변환
  const safeOrigin = !origin || origin === 'ALL_KOREA' ? 'ICN' : origin.toUpperCase();
  const safeDest = (destination || 'NRT').toUpperCase();

  const depCompact = (departureDate || '').replace(/-/g, '');
  const retCompact = (returnDate || '').replace(/-/g, '');
  const skyscannerDep = depCompact.slice(2);
  const skyscannerRet = retCompact.slice(2);

  const paxQuery = `adult=${adults}&child=${children}&infant=${infants}&isDirect=${directOnly ? 'true' : 'false'}&fareType=Y`;

  // 네이버 항공권 (출국편도 / 귀국편도 / 왕복통합)
  const outboundNaverUrl = `https://flight.naver.com/flights/international/${safeOrigin}-${safeDest}-${depCompact}?${paxQuery}`;
  const inboundNaverUrl = `https://flight.naver.com/flights/international/${safeDest}-${safeOrigin}-${retCompact}?${paxQuery}`;
  const naverUrl = `https://flight.naver.com/flights/international/${safeOrigin}-${safeDest}-${depCompact}/${safeDest}-${safeOrigin}-${retCompact}?${paxQuery}`;

  // 스카이스캐너 (출국편도 / 귀국편도 / 왕복통합)
  const outboundSkyscannerUrl = `https://www.skyscanner.co.kr/transport/flights/${safeOrigin.toLowerCase()}/${safeDest.toLowerCase()}/${skyscannerDep}/?adults=${adults}&children=${children}&infants=${infants}&preferdirects=${directOnly ? 'true' : 'false'}`;
  const inboundSkyscannerUrl = `https://www.skyscanner.co.kr/transport/flights/${safeDest.toLowerCase()}/${safeOrigin.toLowerCase()}/${skyscannerRet}/?adults=${adults}&children=${children}&infants=${infants}&preferdirects=${directOnly ? 'true' : 'false'}`;
  const skyscannerUrl = `https://www.skyscanner.co.kr/transport/flights/${safeOrigin.toLowerCase()}/${safeDest.toLowerCase()}/${skyscannerDep}/${skyscannerRet}/?adults=${adults}&children=${children}&infants=${infants}&preferdirects=${directOnly ? 'true' : 'false'}`;

  // 글로벌 메타서치 & OTA (구글 플라이트 / 트립닷컴 / 카약)
  const googleFlightsUrl = `https://www.google.com/travel/flights?q=Flights%20to%20${safeDest}%20from%20${safeOrigin}%20on%20${departureDate}%20through%20${returnDate}&curr=KRW&hl=ko`;
  const tripComUrl = `https://kr.trip.com/flights/${safeOrigin.toLowerCase()}-to-${safeDest.toLowerCase()}/tickets-${safeOrigin.toLowerCase()}-${safeDest.toLowerCase()}?dcity=${safeOrigin}&acity=${safeDest}&ddate=${departureDate}&rdate=${returnDate}&flighttype=rt&class=y&quantity=${adults}&childqty=${children}&babyqty=${infants}`;
  const kayakUrl = `https://www.kayak.co.kr/flights/${safeOrigin}-${safeDest}/${departureDate}/${returnDate}/${adults}adults`;

  // 항공사 공식 홈페이지 링크
  const outboundAirlineOfficialUrl = getAirlineOfficialBookingUrl(outboundAirline);
  const inboundAirlineOfficialUrl = getAirlineOfficialBookingUrl(inboundAirline);

  return {
    outboundNaverUrl,
    inboundNaverUrl,
    naverUrl,
    outboundSkyscannerUrl,
    inboundSkyscannerUrl,
    skyscannerUrl,
    googleFlightsUrl,
    tripComUrl,
    kayakUrl,
    outboundAirlineOfficialUrl,
    inboundAirlineOfficialUrl,
    primaryUrl: naverUrl
  };
}

module.exports = {
  INDIVIDUAL_KOREAN_AIRPORTS,
  KOREAN_ORIGIN_AIRPORTS,
  INTERNATIONAL_DESTINATIONS,
  makeDest,
  getOriginByCode,
  getEligibleKoreanOriginsForDestination,
  getDestinationByCode,
  calculatePassengerPricing,
  getAirlineOfficialBookingUrl,
  buildBookingLinks
};
