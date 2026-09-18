// Traducción EN→ES de nombres de equipo (sobre todo SELECCIONES NACIONALES, que
// API-Football devuelve en inglés: "Belgium", "Wales"...). Los clubes son nombres
// propios y se quedan igual (no están en el mapa → esTeam() devuelve el original).
//
// Uso: esTeam('Belgium') → 'Bélgica'. Idempotente: esTeam('Bélgica') → 'Bélgica'
// (los valores ES no son claves del mapa). Seguro aplicar varias veces.

const COUNTRY_ES = {
  // UEFA
  'Belgium': 'Bélgica', 'Croatia': 'Croacia', 'England': 'Inglaterra', 'Wales': 'Gales',
  'Scotland': 'Escocia', 'Northern Ireland': 'Irlanda del Norte', 'Ireland': 'Irlanda',
  'Republic of Ireland': 'Irlanda', 'France': 'Francia', 'Germany': 'Alemania',
  'Spain': 'España', 'Italy': 'Italia', 'Netherlands': 'Países Bajos', 'Holland': 'Países Bajos',
  'Portugal': 'Portugal', 'Switzerland': 'Suiza', 'Austria': 'Austria', 'Poland': 'Polonia',
  'Sweden': 'Suecia', 'Norway': 'Noruega', 'Denmark': 'Dinamarca', 'Finland': 'Finlandia',
  'Iceland': 'Islandia', 'Russia': 'Rusia', 'Ukraine': 'Ucrania', 'Turkey': 'Turquía',
  'Türkiye': 'Turquía', 'Greece': 'Grecia', 'Czech Republic': 'Chequia', 'Czechia': 'Chequia',
  'Slovakia': 'Eslovaquia', 'Slovenia': 'Eslovenia', 'Hungary': 'Hungría', 'Romania': 'Rumanía',
  'Bulgaria': 'Bulgaria', 'Serbia': 'Serbia', 'Croatia ': 'Croacia', 'Bosnia and Herzegovina': 'Bosnia y Herzegovina',
  'Montenegro': 'Montenegro', 'North Macedonia': 'Macedonia del Norte', 'Macedonia': 'Macedonia del Norte',
  'Albania': 'Albania', 'Kosovo': 'Kosovo', 'Georgia': 'Georgia', 'Armenia': 'Armenia',
  'Azerbaijan': 'Azerbaiyán', 'Belarus': 'Bielorrusia', 'Lithuania': 'Lituania', 'Latvia': 'Letonia',
  'Estonia': 'Estonia', 'Moldova': 'Moldavia', 'Cyprus': 'Chipre', 'Malta': 'Malta',
  'Luxembourg': 'Luxemburgo', 'Andorra': 'Andorra', 'San Marino': 'San Marino', 'Gibraltar': 'Gibraltar',
  'Liechtenstein': 'Liechtenstein', 'Faroe Islands': 'Islas Feroe', 'Kazakhstan': 'Kazajistán',
  'Israel': 'Israel',
  // CONMEBOL
  'Argentina': 'Argentina', 'Brazil': 'Brasil', 'Uruguay': 'Uruguay', 'Colombia': 'Colombia',
  'Chile': 'Chile', 'Peru': 'Perú', 'Paraguay': 'Paraguay', 'Ecuador': 'Ecuador',
  'Bolivia': 'Bolivia', 'Venezuela': 'Venezuela',
  // CONCACAF
  'United States': 'Estados Unidos', 'USA': 'Estados Unidos', 'Mexico': 'México', 'Canada': 'Canadá',
  'Costa Rica': 'Costa Rica', 'Honduras': 'Honduras', 'Panama': 'Panamá', 'Jamaica': 'Jamaica',
  'El Salvador': 'El Salvador', 'Guatemala': 'Guatemala', 'Haiti': 'Haití', 'Trinidad and Tobago': 'Trinidad y Tobago',
  'Curacao': 'Curazao', 'Curaçao': 'Curazao', 'Nicaragua': 'Nicaragua', 'Cuba': 'Cuba',
  'Dominican Republic': 'República Dominicana', 'Suriname': 'Surinam', 'Guadeloupe': 'Guadalupe',
  // CONMEBOL/CONCACAF clubs comunes que vienen con país en inglés se mantienen.
  // AFC
  'Japan': 'Japón', 'South Korea': 'Corea del Sur', 'Korea Republic': 'Corea del Sur',
  'North Korea': 'Corea del Norte', 'China': 'China', 'China PR': 'China', 'Australia': 'Australia',
  'Saudi Arabia': 'Arabia Saudita', 'Iran': 'Irán', 'Iraq': 'Irak', 'Qatar': 'Catar',
  'United Arab Emirates': 'Emiratos Árabes Unidos', 'Jordan': 'Jordania', 'Bahrain': 'Baréin',
  'Kuwait': 'Kuwait', 'Oman': 'Omán', 'Lebanon': 'Líbano', 'Syria': 'Siria', 'Palestine': 'Palestina',
  'Yemen': 'Yemen', 'India': 'India', 'Thailand': 'Tailandia', 'Vietnam': 'Vietnam',
  'Indonesia': 'Indonesia', 'Malaysia': 'Malasia', 'Singapore': 'Singapur', 'Philippines': 'Filipinas',
  'Uzbekistan': 'Uzbekistán', 'Turkmenistan': 'Turkmenistán', 'Tajikistan': 'Tayikistán',
  'Kyrgyzstan': 'Kirguistán', 'Hong Kong': 'Hong Kong', 'New Zealand': 'Nueva Zelanda',
  // CAF
  'Morocco': 'Marruecos', 'Algeria': 'Argelia', 'Tunisia': 'Túnez', 'Egypt': 'Egipto',
  'Libya': 'Libia', 'Senegal': 'Senegal', 'Ivory Coast': 'Costa de Marfil', "Cote d'Ivoire": 'Costa de Marfil',
  'Nigeria': 'Nigeria', 'Ghana': 'Ghana', 'Cameroon': 'Camerún', 'Mali': 'Malí', 'Egypt ': 'Egipto',
  'Burkina Faso': 'Burkina Faso', 'South Africa': 'Sudáfrica', 'DR Congo': 'RD Congo',
  'Congo DR': 'RD Congo', 'Congo': 'Congo', 'Guinea': 'Guinea', 'Gabon': 'Gabón',
  'Cape Verde': 'Cabo Verde', 'Cabo Verde': 'Cabo Verde', 'Zambia': 'Zambia', 'Angola': 'Angola',
  'Equatorial Guinea': 'Guinea Ecuatorial', 'Madagascar': 'Madagascar', 'Mauritania': 'Mauritania',
  'Benin': 'Benín', 'Togo': 'Togo', 'Uganda': 'Uganda', 'Kenya': 'Kenia', 'Tanzania': 'Tanzania',
  'Zimbabwe': 'Zimbabue', 'Mozambique': 'Mozambique', 'Namibia': 'Namibia', 'Sudan': 'Sudán',
  'Ethiopia': 'Etiopía', 'Guinea-Bissau': 'Guinea-Bisáu', 'Sierra Leone': 'Sierra Leona',
  'Liberia': 'Liberia', 'Gambia': 'Gambia', 'Comoros': 'Comoras', 'Niger': 'Níger',
  'Central African Republic': 'República Centroafricana', 'Rwanda': 'Ruanda', 'Burundi': 'Burundi',
  'Malawi': 'Malaui', 'Botswana': 'Botsuana', 'Eswatini': 'Esuatini', 'Lesotho': 'Lesoto',
  // OFC / otros
  'Fiji': 'Fiyi', 'Papua New Guinea': 'Papúa Nueva Guinea', 'Tahiti': 'Tahití',
  'Solomon Islands': 'Islas Salomón', 'New Caledonia': 'Nueva Caledonia', 'Vanuatu': 'Vanuatu',
};

export function esTeam(name) {
  if (!name || typeof name !== 'string') return name;
  return COUNTRY_ES[name] || COUNTRY_ES[name.trim()] || name;
}

export { COUNTRY_ES };
