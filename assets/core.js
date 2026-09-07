(function (global) {
  'use strict';

  function normalizeForSearch(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[、。・「」『』（）()【】\[\]：:／/\-－—_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeSpace(value) {
    return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  function extractCourseNumber(text) {
    const normalized = String(text || '').normalize('NFKC');
    const patterns = [
      /第\s*(\d{1,2})\s*回/,
      /講座\s*(?:番号)?\s*(\d{1,2})/,
      /^\s*(\d{1,2})\s*$/
    ];
    for (const pattern of patterns) {
      const m = normalized.match(pattern);
      if (m) return Number(m[1]);
    }
    return null;
  }

  function extractBranch(text) {
    const t = String(text || '').normalize('NFKC');
    const map = { '①': 1, '②': 2, '③': 3, '④': 4 };
    for (const [mark, value] of Object.entries(map)) {
      if (t.includes(mark)) return value;
    }
    const m = t.match(/11\s*(?:回)?\s*[-－]?\s*([1-4])/);
    return m ? Number(m[1]) : null;
  }

  function exactCourseFromText(courses, text) {
    const number = extractCourseNumber(text);
    if (number === null) return null;
    const candidates = courses.filter((course) => Number(course.number) === number);
    if (candidates.length === 1) return candidates[0];
    if (number === 11) {
      const branch = extractBranch(text);
      if (branch) return candidates.find((course) => Number(course.branch) === branch) || null;
    }
    return null;
  }

  function searchCourses(courses, query) {
    const q = normalizeForSearch(query);
    if (!q) return [];
    const number = extractCourseNumber(query);
    const terms = q.split(/\s+/).filter(Boolean);

    return courses
      .map((course) => {
        const hay = normalizeForSearch(`${course.display} ${course.title} ${course.lecturer} ${course.overview} ${course.searchText}`);
        let score = 0;
        if (number !== null && Number(course.number) === number) score += 120;
        for (const term of terms) {
          if (normalizeForSearch(course.title).includes(term)) score += 16;
          if (normalizeForSearch(course.display).includes(term)) score += 14;
          if (hay.includes(term)) score += 5;
        }
        return { course, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || Number(a.course.number) - Number(b.course.number))
      .map((item) => item.course);
  }

  function normalizePhone(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[〇零]/g, '0').replace(/[一]/g, '1').replace(/[二]/g, '2').replace(/[三]/g, '3').replace(/[四]/g, '4')
      .replace(/[五]/g, '5').replace(/[六]/g, '6').replace(/[七]/g, '7').replace(/[八]/g, '8').replace(/[九]/g, '9')
      .replace(/\D/g, '');
  }

  function formatDate(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return String(iso);
    return `${y}年${m}月${d}日`;
  }

  function isDeadlinePast(iso, nowMs) {
    if (!iso) return false;
    const deadline = new Date(`${iso}T23:59:59+09:00`);
    const current = typeof nowMs === 'number' ? nowMs : Date.now();
    return current > deadline.getTime();
  }

  global.ReceptionCore = Object.freeze({
    normalizeForSearch,
    normalizeSpace,
    extractCourseNumber,
    extractBranch,
    exactCourseFromText,
    searchCourses,
    normalizePhone,
    formatDate,
    isDeadlinePast
  });
})(typeof window !== 'undefined' ? window : globalThis);
