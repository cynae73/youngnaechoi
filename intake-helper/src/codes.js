'use strict';
/* 기초코드(BASE0080) 그룹에서 의뢰서 문구에 맞는 코드를 찾는다. 그룹 번호를 추측해서 박아 두지 않고 이름으로 찾는다. */
/* 의뢰서 표기와 코드 이름이 다른 흔한 경우를 맞춘다. 모르는 표기는 억지로 맞추지 않고 '미매칭'으로 둔다. */
const SYN = [[/상온/g, '실온'], [/전자우편|전자메일|e-?mail|이메일/gi, '메일'], [/우송/g, '우편']];
const norm = (s) => SYN.reduce((t, [re, to]) => t.replace(re, to), String(s || '').replace(/[\s()（）·.,/_-]/g, '').toLowerCase());

function findGroup(groups, re) {
  const hit = Object.entries(groups).filter(([, g]) => re.test(g.name || ''));
  return hit.length ? { id: hit[0][0], name: hit[0][1].name, codes: hit[0][1].codes, ambiguous: hit.length > 1 } : null;
}

function matchIn(group, text) {
  const t = norm(text);
  if (!group || !t) return null;
  const list = Object.entries(group.codes).map(([code, name]) => ({ code, name, n: norm(name) }));
  return list.find((c) => c.n === t) || list.find((c) => c.n && (c.n.includes(t) || t.includes(c.n))) || null;
}

function matchOrder(groups, o) {
  const out = {};
  const spec = [
    ['purpose', /의뢰\s*목적/, o.purpose],
    ['storage', /보관/, o.storage],
    ['delivery', /통보|성적서\s*전달|수령/, String(o.report.delivery || '').split(/[,/·\s]+/).filter(Boolean)[0]],
  ];
  spec.forEach(([k, re, text]) => {
    const g = findGroup(groups, re);
    if (!g) { out[k] = { status: 'nogroup', text }; return; }
    if (!text) { out[k] = { status: 'empty', group: g.id + ' ' + g.name }; return; }
    const m = matchIn(g, text);
    out[k] = m ? { status: 'ok', code: m.code, name: m.name, group: g.id + ' ' + g.name, text }
      : { status: 'miss', text, group: g.id + ' ' + g.name, options: Object.values(g.codes).slice(0, 12) };
  });
  return out;
}

module.exports = { findGroup, matchIn, matchOrder };
