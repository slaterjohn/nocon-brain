// Data tables that drive the article site, the sitemap/feeds and the fake search providers.
import { hash32 } from './lib.mjs';

export const SENTENCES = {
  astro: [
    'The solar system formed about 4.6 billion years ago from the collapse of a giant molecular cloud.',
    'Planets orbit the Sun in nearly circular paths, and the four inner planets are small and rocky.',
    'A black hole is a region of spacetime where gravity is so strong that nothing, not even light, can escape.',
    'Stellar black holes form when massive stars exhaust their nuclear fuel and collapse under their own weight.',
    'Telescopes collect faint light, letting astronomers measure the distances, motions and chemistry of distant objects.',
    'The giant planets Jupiter and Saturn are mostly hydrogen and helium, with deep atmospheres and many moons.',
    'Comets are icy bodies that grow bright tails when their orbits carry them close to the Sun.',
    'The Milky Way contains hundreds of billions of stars, most of them orbiting a central supermassive black hole.',
    'Astronomers detect exoplanets by watching for tiny dips in starlight as a planet crosses in front of its star.',
    'The asteroid belt between Mars and Jupiter holds the leftover building blocks of the early solar system.',
    'Gravitational waves from merging black holes were first detected in 2015, opening a new way to observe the universe.',
    'Orbital periods grow longer with distance: Mercury takes 88 days, while Neptune takes about 165 years.',
  ],
  energy: [
    'Renewable energy comes from sources that are replenished naturally, such as sunlight, wind and flowing water.',
    'Solar panels convert sunlight directly into electricity, and their cost has fallen sharply over the past decade.',
    'Wind turbines turn the kinetic energy of moving air into electrical power, onshore and offshore.',
    'Hydropower is the largest source of renewable electricity, though new dams raise ecological questions.',
    'Energy storage, from lithium batteries to pumped hydro, smooths out the variable output of wind and solar.',
    'Geothermal plants use heat from the Earth, which makes them steady sources of baseload power.',
    'A modern grid must balance supply and demand every second, so forecasting and flexible demand matter.',
    'Biomass can replace fossil fuels in heating and transport, but sustainable sourcing is essential.',
    'Capacity factor measures how much of its maximum output a power plant actually delivers over a year.',
    'Heat pumps move heat rather than creating it, delivering three or more units of heat per unit of electricity.',
  ],
  misc: [
    'Good results come from patient preparation and from measuring ingredients and timings carefully.',
    'Beginners often skip the basics, then spend more time repairing mistakes than they would have spent learning.',
    'Local conditions such as weather, soil or water quality change what works from place to place.',
    'Records from earlier seasons are the best guide to what to do differently next time.',
    'A small amount of regular practice beats an occasional long session.',
    'Tools do not need to be expensive, but they should be well maintained and the right size for the job.',
  ],
  fr: [
    'Le système solaire s’est formé il y a environ 4,6 milliards d’années à partir d’un nuage de gaz et de poussière.',
    'Les planètes tournent autour du Soleil, et les quatre planètes intérieures sont petites et rocheuses.',
    'Un trou noir est une région de l’espace où la gravité est si forte que même la lumière ne peut s’en échapper.',
    'Les astronomes utilisent des télescopes pour mesurer la distance et la composition des étoiles lointaines.',
  ],
};

export const FACTS = {
  astro: [['Sun', '1.989e30 kg'], ['Earth', '5.972e24 kg'], ['Jupiter', '1.898e27 kg'], ['Sagittarius A*', '4.3e6 solar masses']],
  energy: [['Solar PV', '20% typical efficiency'], ['Onshore wind', '35% capacity factor'], ['Hydropower', '40% capacity factor'], ['Geothermal', '75% capacity factor']],
  misc: [['Difficulty', 'Beginner'], ['Time', '2 hours'], ['Cost', 'Low'], ['Season', 'Any']],
  fr: [['Soleil', '1,989e30 kg'], ['Terre', '5,972e24 kg']],
};

export const CODE = {
  astro: 'orbital_period = 2 * pi * sqrt(a**3 / (G * M))   # Kepler\'s third law',
  energy: 'annual_kwh = capacity_kw * capacity_factor * 8760',
  misc: 'repeat while not done: measure(); adjust()',
  fr: 'periode = 2 * pi * racine(a**3 / (G * M))',
};

// [slug, title, topic, extra]  extra: {lead, lang, canonicalOf, copyOf, tweak, special}
const P = (slug, title, topic, extra = {}) => ({ slug, title, topic, ...extra });
export const PAGES = [
  P('astronomy', 'Astronomy', 'astro', {
    lead: 'Astronomy is the scientific study of the solar system, black holes, planets, stars and galaxies, and of the universe as a whole.',
  }),
  P('solar-system', 'The Solar System', 'astro', { lead: 'The solar system is the Sun and everything bound to it by gravity: eight planets, their moons, asteroids and comets.' }),
  P('black-holes', 'Black Holes', 'astro', { lead: 'Black holes are the densest known objects, and they shape the galaxies that host them.' }),
  P('planets', 'Planets', 'astro', { lead: 'Planets are large bodies that orbit a star, are rounded by their own gravity and have cleared their orbital neighbourhood.' }),
  P('stars', 'Stars', 'astro'),
  P('galaxies', 'Galaxies', 'astro'),
  P('comets', 'Comets', 'astro'),
  P('telescopes', 'Telescopes', 'astro'),
  P('exoplanets', 'Exoplanets', 'astro'),
  P('moon', 'The Moon', 'astro'),
  P('mars', 'Mars', 'astro'),
  P('jupiter', 'Jupiter', 'astro'),
  P('renewable-energy', 'Renewable Energy', 'energy', { lead: 'Renewable energy is power from sources that renew themselves on a human timescale: sun, wind, water, heat from the Earth and plant matter.' }),
  P('solar-power', 'Solar Power', 'energy'),
  P('wind-power', 'Wind Power', 'energy'),
  P('hydropower', 'Hydropower', 'energy'),
  P('geothermal-energy', 'Geothermal Energy', 'energy'),
  P('biomass', 'Biomass', 'energy'),
  P('energy-storage', 'Energy Storage', 'energy'),
  P('power-grid', 'The Power Grid', 'energy'),
  P('bread-baking', 'Bread Baking', 'misc'),
  P('coffee-brewing', 'Coffee Brewing', 'misc'),
  P('urban-gardening', 'Urban Gardening', 'misc'),
  P('medieval-castles', 'Medieval Castles', 'misc'),
  P('tide-pools', 'Tide Pools', 'misc'),
  // Near duplicates of renewable-energy / solar-system / astronomy.
  P('renewable-energy-copy', 'Renewable Energy', 'energy', { copyOf: 'renewable-energy', canonicalOf: 'renewable-energy' }),
  P('renewable-energy-print', 'Renewable Energy (print version)', 'energy', { copyOf: 'renewable-energy', canonicalOf: 'renewable-energy' }),
  P('renewable-energy-v2', 'Renewable Energy', 'energy', { copyOf: 'renewable-energy', tweak: true }),
  P('solar-system-mirror', 'The Solar System', 'astro', { copyOf: 'solar-system' }),
  P('astronomy-syndicated', 'Astronomy: a syndicated edition', 'astro', { copyOf: 'astronomy', tweak: true, canonicalOf: 'astronomy' }),
  // Language variant.
  P('fr/astronomie', 'Astronomie', 'fr', { lang: 'fr', lead: 'L’astronomie est l’étude du système solaire, des trous noirs, des planètes, des étoiles et des galaxies.' }),
];

export const PUBLISHED_BASE = Date.UTC(2025, 0, 6, 9, 0, 0);
export function metaFor(page, i) {
  const published = new Date(PUBLISHED_BASE + i * 5 * 86400000);
  const modified = new Date(published.getTime() + (3 + (hash32(page.slug) % 20)) * 86400000);
  return { published: published.toISOString(), modified: modified.toISOString() };
}
export const ARTICLES = PAGES.map((p, i) => ({ ...p, ...metaFor(p, i) }));
export const bySlug = Object.fromEntries(ARTICLES.map((a) => [a.slug, a]));

export const AUTHORS = ['Ada Marlowe', 'Tomas Ferreira', 'Priya Natarajan', 'Eleni Kostas'];
export const authorFor = (slug) => AUTHORS[hash32(slug) % AUTHORS.length];

/** Deterministic paragraphs for a page. */
export function paragraphs(page, count = 4) {
  const src = bySlug[page.copyOf] || page;
  const pool = SENTENCES[src.topic];
  const start = hash32(src.slug) % pool.length;
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = pool[(start + i * 3) % pool.length];
    const b = pool[(start + i * 3 + 1) % pool.length];
    const c = pool[(start + i * 3 + 2) % pool.length];
    out.push(`${a} ${b} ${c}`);
  }
  if (page.tweak) {
    if (out[1]) out[1] = out[1].replace(/\.$/, '') + ', according to recent surveys.';
    if (out[2]) out[2] = 'Editor\'s note: this edition was lightly rewritten for syndication. ' + out[2];
  }
  return out;
}

// Search-result catalogue used by the fake providers. Keys are article slugs, link-graph ids, or online-only ids.
export const ONLINE_ONLY = [
  { id: 1, title: 'Live telescope observing log (online only)', snippet: 'A live observing log about astronomy, planets and black holes. This page is not archived.' },
  { id: 2, title: 'Offshore wind farm status dashboard (online only)', snippet: 'Live renewable energy output for wind and solar sites.' },
  { id: 3, title: 'Mars rover weekly update (online only)', snippet: 'This week on Mars: planets, rocks and dust.' },
  { id: 4, title: 'Grid demand explained (online only)', snippet: 'How the power grid balances renewable energy and demand.' },
  { id: 5, title: 'XSS test page (online only)', snippet: 'Placeholder page for provider payload tests.' },
];
