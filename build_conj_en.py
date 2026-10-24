#!/usr/bin/env python3
"""Builds conj-en/verbs.json: the English verb chart for a Spanish speaker learning English (María Antonieta's side).

  python3 -I build_conj_en.py            (from the repo root; needs dict/en/ and conj/ already built)
  ~/lector-build/venv/bin/python -I build_conj_en.py --rank   (also orders the verbs by wordfreq frequency)

For each verb: base, -s, past, past participle, -ing; the Spanish meaning; the Spanish verb whose own forms translate
each cell ("I had" → "yo tuve"), taken from Lector's Spanish tables in conj/ (Wiktionary via kaikki.org); the
irregular family; and marks for the colours: irr (red) = the part of an irregular past or participle that differs from
the base, spell (blue) = a regular spelling change (stopped, tried, making, watches, lying).

Every irregular past and participle, and every -s and -ing form, is checked against English Wiktionary's own form-of
entries (dict/en/, kaikki.org extract): a form Wiktionary does not list as that form of that verb stops the build.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
# base, Spanish meaning, Spanish verb for the translations ('' = none: the cell shows the meaning only), family.
# Families (irregular verbs only):
#   same   past and participle are the base (put, put, put)
#   iau    i in the base, a in the past, u in the participle (sing, sang, sung)
#   ought  past and participle end in -ought or -aught (buy, bought; teach, taught)
#   ewown  past in -ew, participle in -wn (know, knew, known)
#   vowel  one vowel changes, past and participle the same (sit, sat; find, found) — get keeps gotten (US)
#   t      past and participle end in -t (feel, felt; keep, kept)
#   en     participle ends in -en or -n with a new past (take, took, taken; eat, ate, eaten)
#   true   be, go, do, have: learned whole
#   other  irregular, no family (say, said; come, came, come)
IRR = {
  # base: (past, participle, family)
  'be': ('was / were', 'been', 'true'), 'have': ('had', 'had', 'true'), 'do': ('did', 'done', 'true'), 'go': ('went', 'gone', 'true'),
  'put': ('put', 'put', 'same'), 'let': ('let', 'let', 'same'), 'cut': ('cut', 'cut', 'same'), 'hit': ('hit', 'hit', 'same'), 'set': ('set', 'set', 'same'),
  'hurt': ('hurt', 'hurt', 'same'), 'shut': ('shut', 'shut', 'same'), 'cost': ('cost', 'cost', 'same'), 'quit': ('quit', 'quit', 'same'),
  'spread': ('spread', 'spread', 'same'), 'read': ('read', 'read', 'same'), 'bet': ('bet', 'bet', 'same'),
  'sing': ('sang', 'sung', 'iau'), 'drink': ('drank', 'drunk', 'iau'), 'swim': ('swam', 'swum', 'iau'), 'begin': ('began', 'begun', 'iau'),
  'ring': ('rang', 'rung', 'iau'), 'sink': ('sank', 'sunk', 'iau'),
  'think': ('thought', 'thought', 'ought'), 'bring': ('brought', 'brought', 'ought'), 'buy': ('bought', 'bought', 'ought'),
  'fight': ('fought', 'fought', 'ought'), 'seek': ('sought', 'sought', 'ought'), 'teach': ('taught', 'taught', 'ought'), 'catch': ('caught', 'caught', 'ought'),
  'know': ('knew', 'known', 'ewown'), 'grow': ('grew', 'grown', 'ewown'), 'throw': ('threw', 'thrown', 'ewown'), 'fly': ('flew', 'flown', 'ewown'),
  'blow': ('blew', 'blown', 'ewown'), 'draw': ('drew', 'drawn', 'ewown'),
  'get': ('got', 'gotten', 'vowel'), 'sit': ('sat', 'sat', 'vowel'), 'find': ('found', 'found', 'vowel'), 'win': ('won', 'won', 'vowel'),
  'meet': ('met', 'met', 'vowel'), 'hold': ('held', 'held', 'vowel'), 'lead': ('led', 'led', 'vowel'), 'feed': ('fed', 'fed', 'vowel'),
  'shoot': ('shot', 'shot', 'vowel'), 'dig': ('dug', 'dug', 'vowel'), 'hang': ('hung', 'hung', 'vowel'), 'stick': ('stuck', 'stuck', 'vowel'),
  'swing': ('swung', 'swung', 'vowel'),
  'feel': ('felt', 'felt', 't'), 'leave': ('left', 'left', 't'), 'mean': ('meant', 'meant', 't'), 'keep': ('kept', 'kept', 't'), 'lose': ('lost', 'lost', 't'),
  'spend': ('spent', 'spent', 't'), 'build': ('built', 'built', 't'), 'send': ('sent', 'sent', 't'), 'sleep': ('slept', 'slept', 't'),
  'lend': ('lent', 'lent', 't'), 'bend': ('bent', 'bent', 't'), 'sweep': ('swept', 'swept', 't'), 'deal': ('dealt', 'dealt', 't'),
  'take': ('took', 'taken', 'en'), 'see': ('saw', 'seen', 'en'), 'give': ('gave', 'given', 'en'), 'write': ('wrote', 'written', 'en'),
  'speak': ('spoke', 'spoken', 'en'), 'fall': ('fell', 'fallen', 'en'), 'break': ('broke', 'broken', 'en'), 'drive': ('drove', 'driven', 'en'),
  'eat': ('ate', 'eaten', 'en'), 'choose': ('chose', 'chosen', 'en'), 'forget': ('forgot', 'forgotten', 'en'), 'hide': ('hid', 'hidden', 'en'),
  'ride': ('rode', 'ridden', 'en'), 'wake': ('woke', 'woken', 'en'), 'rise': ('rose', 'risen', 'en'), 'steal': ('stole', 'stolen', 'en'),
  'bite': ('bit', 'bitten', 'en'), 'beat': ('beat', 'beaten', 'en'), 'shake': ('shook', 'shaken', 'en'), 'freeze': ('froze', 'frozen', 'en'),
  'forgive': ('forgave', 'forgiven', 'en'),
  'say': ('said', 'said', 'other'), 'make': ('made', 'made', 'other'), 'come': ('came', 'come', 'other'), 'tell': ('told', 'told', 'other'),
  'become': ('became', 'become', 'other'), 'run': ('ran', 'run', 'other'), 'stand': ('stood', 'stood', 'other'), 'hear': ('heard', 'heard', 'other'),
  'pay': ('paid', 'paid', 'other'), 'understand': ('understood', 'understood', 'other'), 'sell': ('sold', 'sold', 'other'),
  'wear': ('wore', 'worn', 'other'), 'light': ('lit', 'lit', 'other'), 'lay': ('laid', 'laid', 'other'), 'show': ('showed', 'shown', 'other'),
}
VERBS = [
  # base, Spanish meaning, Spanish verb (its forms translate each cell)
  ('be', 'ser, estar', 'ser'), ('have', 'tener', 'tener'), ('do', 'hacer', 'hacer'), ('go', 'ir', 'ir'), ('say', 'decir', 'decir'),
  ('get', 'conseguir, obtener', 'conseguir'), ('make', 'hacer, fabricar', 'hacer'), ('know', 'saber, conocer', 'saber'), ('think', 'pensar', 'pensar'),
  ('take', 'tomar, llevar', 'tomar'), ('see', 'ver', 'ver'), ('come', 'venir', 'venir'), ('give', 'dar', 'dar'), ('find', 'encontrar', 'encontrar'),
  ('tell', 'decir, contar', 'contar'), ('feel', 'sentir', 'sentir'), ('become', 'volverse, convertirse en', 'convertirse'), ('leave', 'irse, salir, dejar', 'salir'),
  ('put', 'poner', 'poner'), ('mean', 'significar, querer decir', 'significar'), ('keep', 'guardar, seguir', 'guardar'), ('let', 'dejar, permitir', 'dejar'),
  ('begin', 'empezar', 'empezar'), ('run', 'correr', 'correr'), ('write', 'escribir', 'escribir'), ('bring', 'traer', 'traer'),
  ('hold', 'sostener, agarrar', 'sostener'), ('stand', 'estar de pie, pararse', 'pararse'), ('hear', 'oír', 'oír'), ('lose', 'perder', 'perder'),
  ('meet', 'conocer, encontrarse con', 'conocer'), ('pay', 'pagar', 'pagar'), ('sit', 'sentarse', 'sentarse'), ('speak', 'hablar', 'hablar'),
  ('lead', 'guiar, llevar', 'guiar'), ('read', 'leer', 'leer'), ('grow', 'crecer', 'crecer'), ('spend', 'gastar; pasar (tiempo)', 'gastar'),
  ('win', 'ganar', 'ganar'), ('understand', 'entender', 'entender'), ('build', 'construir', 'construir'), ('send', 'enviar, mandar', 'enviar'),
  ('fall', 'caer', 'caer'), ('break', 'romper', 'romper'), ('buy', 'comprar', 'comprar'), ('cut', 'cortar', 'cortar'), ('sell', 'vender', 'vender'),
  ('teach', 'enseñar', 'enseñar'), ('catch', 'atrapar, agarrar', 'atrapar'), ('drive', 'manejar', 'manejar'), ('eat', 'comer', 'comer'),
  ('draw', 'dibujar', 'dibujar'), ('choose', 'elegir', 'elegir'), ('throw', 'tirar, lanzar', 'lanzar'), ('fly', 'volar', 'volar'),
  ('forget', 'olvidar', 'olvidar'), ('hit', 'golpear', 'golpear'), ('hurt', 'lastimar, doler', 'lastimar'), ('set', 'poner, fijar', 'fijar'),
  ('shut', 'cerrar', 'cerrar'), ('cost', 'costar', 'costar'), ('quit', 'dejar, renunciar', 'renunciar'), ('sing', 'cantar', 'cantar'),
  ('drink', 'beber, tomar', 'beber'), ('swim', 'nadar', 'nadar'), ('ring', 'sonar', 'sonar'), ('sink', 'hundirse', 'hundirse'),
  ('fight', 'pelear', 'pelear'), ('seek', 'buscar', 'buscar'), ('sleep', 'dormir', 'dormir'), ('feed', 'dar de comer', 'alimentar'),
  ('shoot', 'disparar', 'disparar'), ('hide', 'esconder', 'esconder'), ('ride', 'montar, andar en', 'montar'), ('wake', 'despertar', 'despertar'),
  ('wear', 'llevar puesto, usar', 'usar'), ('blow', 'soplar', 'soplar'), ('dig', 'cavar', 'cavar'), ('hang', 'colgar', 'colgar'),
  ('stick', 'pegar', 'pegar'), ('swing', 'columpiarse', 'columpiarse'), ('lend', 'prestar', 'prestar'), ('bend', 'doblar', 'doblar'),
  ('light', 'prender, encender', 'encender'), ('lay', 'poner, colocar', 'colocar'), ('rise', 'subir, levantarse', 'subir'), ('steal', 'robar', 'robar'),
  ('bite', 'morder', 'morder'), ('beat', 'vencer, ganarle a', 'vencer'), ('shake', 'sacudir, agitar', 'sacudir'), ('freeze', 'congelar', 'congelar'),
  ('forgive', 'perdonar', 'perdonar'), ('show', 'mostrar, enseñar', 'mostrar'), ('sweep', 'barrer', 'barrer'), ('deal', 'tratar, repartir', 'tratar'),
  ('spread', 'extender, untar', 'extender'), ('bet', 'apostar', 'apostar'),
  # regular
  ('want', 'querer', 'querer'), ('use', 'usar', 'usar'), ('work', 'trabajar', 'trabajar'), ('call', 'llamar', 'llamar'), ('try', 'intentar, probar', 'intentar'),
  ('ask', 'preguntar, pedir', 'preguntar'), ('need', 'necesitar', 'necesitar'), ('seem', 'parecer', 'parecer'), ('help', 'ayudar', 'ayudar'),
  ('talk', 'hablar, platicar', 'platicar'), ('turn', 'voltear, girar', 'voltear'), ('start', 'empezar', 'comenzar'), ('live', 'vivir', 'vivir'),
  ('believe', 'creer', 'creer'), ('happen', 'pasar, suceder', 'suceder'), ('include', 'incluir', 'incluir'), ('continue', 'continuar, seguir', 'continuar'),
  ('learn', 'aprender', 'aprender'), ('change', 'cambiar', 'cambiar'), ('watch', 'mirar, ver', 'mirar'), ('follow', 'seguir', 'seguir'),
  ('stop', 'parar, dejar de', 'parar'), ('create', 'crear', 'crear'), ('open', 'abrir', 'abrir'), ('walk', 'caminar', 'caminar'),
  ('offer', 'ofrecer', 'ofrecer'), ('remember', 'recordar, acordarse', 'recordar'), ('love', 'amar, encantar', 'amar'), ('like', 'gustar (I like = me gusta)', ''),
  ('consider', 'considerar', 'considerar'), ('appear', 'aparecer', 'aparecer'), ('wait', 'esperar', 'esperar'), ('serve', 'servir', 'servir'),
  ('die', 'morir', 'morir'), ('expect', 'esperar (algo)', 'esperar'), ('stay', 'quedarse', 'quedarse'), ('reach', 'alcanzar, llegar a', 'alcanzar'),
  ('raise', 'levantar, criar', 'levantar'), ('pass', 'pasar', 'pasar'), ('decide', 'decidir', 'decidir'), ('pull', 'jalar', 'jalar'),
  ('explain', 'explicar', 'explicar'), ('hope', 'esperar, ojalá', 'esperar'), ('carry', 'cargar, llevar', 'cargar'), ('add', 'agregar', 'agregar'),
  ('move', 'mover, mudarse', 'mover'), ('play', 'jugar, tocar', 'jugar'), ('plan', 'planear', 'planear'), ('study', 'estudiar', 'estudiar'),
  ('cook', 'cocinar', 'cocinar'), ('clean', 'limpiar', 'limpiar'), ('close', 'cerrar', 'cerrar'), ('arrive', 'llegar', 'llegar'),
  ('visit', 'visitar', 'visitar'), ('travel', 'viajar', 'viajar'), ('listen', 'escuchar', 'escuchar'), ('look', 'mirar, verse', 'mirar'),
  ('finish', 'terminar', 'terminar'), ('answer', 'contestar', 'contestar'), ('cry', 'llorar', 'llorar'), ('dance', 'bailar', 'bailar'),
  ('enjoy', 'disfrutar', 'disfrutar'), ('fix', 'arreglar', 'arreglar'), ('hurry', 'apurarse', 'apurarse'), ('jump', 'saltar', 'saltar'),
  ('laugh', 'reírse', 'reír'), ('marry', 'casarse con', 'casarse'), ('miss', 'extrañar; perder (el camión)', 'extrañar'), ('order', 'pedir, ordenar', 'ordenar'),
  ('prefer', 'preferir', 'preferir'), ('push', 'empujar', 'empujar'), ('relax', 'relajarse', 'relajarse'), ('rest', 'descansar', 'descansar'),
  ('return', 'regresar, devolver', 'regresar'), ('share', 'compartir', 'compartir'), ('smile', 'sonreír', 'sonreír'), ('wash', 'lavar', 'lavar'),
  ('worry', 'preocuparse', 'preocuparse'), ('allow', 'permitir', 'permitir'), ('belong', 'pertenecer', 'pertenecer'), ('check', 'revisar', 'revisar'),
  ('count', 'contar (números)', 'contar'), ('cover', 'cubrir', 'cubrir'), ('describe', 'describir', 'describir'), ('enter', 'entrar', 'entrar'),
  ('fill', 'llenar', 'llenar'), ('hug', 'abrazar', 'abrazar'), ('improve', 'mejorar', 'mejorar'), ('invite', 'invitar', 'invitar'),
  ('join', 'unirse a', 'unirse'), ('kiss', 'besar', 'besar'), ('mix', 'mezclar', 'mezclar'), ('paint', 'pintar', 'pintar'),
  ('prepare', 'preparar', 'preparar'), ('promise', 'prometer', 'prometer'), ('rent', 'rentar', 'rentar'), ('save', 'ahorrar, guardar', 'ahorrar'),
  ('taste', 'probar (comida), saber a', 'probar'), ('thank', 'agradecer', 'agradecer'), ('touch', 'tocar', 'tocar'), ('wish', 'desear', 'desear'),
  ('admit', 'admitir', 'admitir'), ('drop', 'dejar caer, tirar', 'tirar'), ('shop', 'ir de compras', ''), ('pick', 'escoger, recoger', 'escoger'),
  ('agree', 'estar de acuerdo', ''), ('fry', 'freír', 'freír'), ('apply', 'aplicar, solicitar', 'solicitar'), ('reply', 'responder', 'responder'),
]

def s_of(b):
    if b in ('be',): return 'is'
    if b == 'have': return 'has'
    if re.search(r'(s|x|z|ch|sh|o)$', b): return b + 'es'
    if re.search(r'[^aeiou]y$', b): return b[:-1] + 'ies'
    return b + 's'
# A final consonant doubles after one stressed short vowel: one-syllable verbs, and these that stress the end.
DOUBLE_END = {'admit', 'prefer', 'begin', 'forget', 'occur', 'permit', 'refer', 'regret', 'control'}
def doubles(b):
    if b.endswith(('w', 'x', 'y')): return False
    one = len(re.findall(r'[aeiou]+', b)) == 1 and re.search(r'[^aeiou][aeiou][bcdfgklmnprstvz]$', b) and not re.search(r'qu[aeiou][a-z]$', b) or b in ('quit',)
    return bool(one) or b in DOUBLE_END
def ed_of(b):
    if b.endswith('e'): return b + 'd'
    if re.search(r'[^aeiou]y$', b): return b[:-1] + 'ied'
    if doubles(b): return b + b[-1] + 'ed'
    return b + 'ed'
def ing_of(b):
    if b in ('be', 'see', 'flee', 'agree'): return b + 'ing'
    if b.endswith('ie'): return b[:-2] + 'ying'
    if re.search(r'[^aeiouy]e$', b) or b.endswith('ue'): return b[:-1] + 'ing'
    if doubles(b): return b + b[-1] + 'ing'
    return b + 'ing'

def irr_slice(base, form):
    if base == form: return None
    a = 0
    while a < len(base) and a < len(form) and base[a] == form[a]: a += 1
    z = 0
    while z < len(base) - a and z < len(form) - a and base[len(base) - 1 - z] == form[len(form) - 1 - z]: z += 1
    return [a, len(form) - z]

def spell_mark(base, form, suffix):
    """The blue part of a regular form whose spelling changes: from the first changed letter to the end."""
    if form == base + suffix or (suffix == 'ed' and base.endswith('e') and form == base + 'd'): return None
    a = 0
    while a < len(base) and a < len(form) and base[a] == form[a]: a += 1
    if a == len(base) and form[a] == base[-1]: a = len(base)     # stopped: the doubled consonant onward
    return ['spell', a, len(form)]

def load_dict(word):
    from unicodedata import normalize
    f = normalize('NFD', word.lower()); f = re.sub(r'[^a-z]', '', f)
    k = f[:2] if len(f) >= 2 else (f + '_')[:2]
    p = os.path.join(ROOT, 'dict', 'en', k + '.json')
    try: return json.load(open(p)).get(word)
    except FileNotFoundError: return None

def listed(form, base, label):
    e = load_dict(form)
    return bool(e) and any(l == base and lab == label for l, lab in e.get('f', []))

def es_table(v):
    if not v: return None
    from unicodedata import normalize
    pron = v.endswith('se') and not os.path.exists('x')
    inf = v[:-2] if v.endswith('se') else v
    f = re.sub(r'[^a-z]', '', normalize('NFD', inf))
    k = f[:2] if len(f) >= 2 else (f + '_')[:2]
    t = json.load(open(os.path.join(ROOT, 'conj', k + '.json'))).get(inf)
    if not t: t = json.load(open(os.path.join(ROOT, 'conj', 'top.json')))['tables'].get(inf)
    if not t: raise SystemExit(f'no Spanish table for {v}')
    se = v.endswith('se') or t.get('se')
    R = ['me', 'te', 'se', 'nos', 'se']
    pre = (lambda i: R[i] + ' ') if se else (lambda i: '')
    HE, ESTOY = ['he', 'has', 'ha', 'hemos', 'han'], ['estoy', 'estás', 'está', 'estamos', 'están']
    return {
        'now': [pre(i) + t['pres'][i] for i in range(5)],
        'past': [pre(i) + t['pret'][i] for i in range(5)],
        'will': [pre(i) + t['fut'][i] for i in range(5)],
        'perf': [pre(i) + HE[i] + ' ' + t['pp'] for i in range(5)],
        'prog': [pre(i) + ESTOY[i] + ' ' + t['ger'] for i in range(5)],
    }

def main():
    out, bad = [], []
    seen = set()
    for b, es, ev in VERBS:
        if b in seen: bad.append('duplicate ' + b); continue
        seen.add(b)
        v = {'b': b, 'es': es, 's': s_of(b), 'ing': ing_of(b)}
        if b in IRR:
            p, pp, fam = IRR[b]; v.update(p=p, pp=pp, f=fam)
        else:
            v.update(p=ed_of(b), pp=ed_of(b))
        # check every form against Wiktionary's own form-of entries
        if b not in ('be', 'have') and not listed(v['s'], b, '3.ª persona'): bad.append(f"{b}: -s {v['s']}")
        if not listed(v['ing'], b, 'gerundio (-ing)'): bad.append(f"{b}: -ing {v['ing']}")
        for f in v['p'].split(' / '):
            if f != b and not listed(f, b, 'pasado'): bad.append(f'{b}: past {f}')
        if v['pp'] != b and not listed(v['pp'], b, 'participio'): bad.append(f"{b}: participle {v['pp']}")
        x = {}
        if b in ('be', 'have'): x['s'] = ['irr'] + irr_slice(b, v['s'])   # is, has
        else:
            m = spell_mark(b, v['s'], 's');  x['s'] = m if m else 0
        m = spell_mark(b, v['ing'], 'ing'); x['ing'] = m if m else 0
        for k in ('p', 'pp'):
            f = v[k]
            if b in IRR:
                sl = irr_slice(b, f) if ' / ' not in f else None
                x[k] = ['irr'] + sl if sl else (['irr', 0, len(f)] if ' / ' in f else 0)
            else:
                m = spell_mark(b, f, 'ed'); x[k] = m if m else 0
        if b == 'be': x['p'] = ['irr', 0, 3]
        if any(x.values()): v['x'] = {k: m for k, m in x.items() if m}
        if ev:
            v['ev'] = ev; v['t'] = es_table(ev)
            if b == 'be': v['t2'] = es_table('estar')
        out.append(v)
    if '--rank' in sys.argv:
        from wordfreq import zipf_frequency
        out.sort(key=lambda v: -zipf_frequency(v['b'], 'en'))
    if bad:
        print('NOT CONFIRMED by Wiktionary:', *bad, sep='\n  '); raise SystemExit(1)
    os.makedirs(os.path.join(ROOT, 'conj-en'), exist_ok=True)
    doc = {'source': 'Forms checked against English Wiktionary (kaikki.org extract, CC BY-SA 4.0); Spanish forms from Lector\'s Spanish verb tables (Wiktionary via kaikki.org, CC BY-SA 4.0); meanings and families by Lector; order by wordfreq (Robyn Speer).',
           'persons': ['I', 'you', 'he / she / it', 'we', 'they'], 'verbs': out}
    json.dump(doc, open(os.path.join(ROOT, 'conj-en', 'verbs.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    fams = {}
    for v in out:
        if 'f' in v: fams.setdefault(v['f'], []).append(v['b'])
    print(len(out), 'verbs;', sum(1 for v in out if 'f' in v), 'irregular;', {k: len(x) for k, x in fams.items()})

if __name__ == '__main__': main()
