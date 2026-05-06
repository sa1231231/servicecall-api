// Maps US/Canada NANP area codes to one of the four IANA timezones the
// dashboard's Client Contact dropdown supports (EST/CT/MT/PT). Used to
// auto-populate `contact_timezone` at agent-creation time based on the
// dispatch number's area code. Best-effort — area codes that span multiple
// zones (a few in TN, KS, NE, ND, SD, OR, ID, FL panhandle) are mapped to
// their dominant zone. Area codes that don't fit any of the four zones —
// notably Arizona (no DST), Hawaii, Alaska, and US territories — return
// null so the dropdown stays unset rather than showing a wrong value.

const ET = "America/New_York";
const CT = "America/Chicago";
const MT = "America/Denver";
const PT = "America/Los_Angeles";

const AREA_CODE_TZ: Record<number, string> = {};

const ET_CODES = [
  202, 203, 207, 212, 215, 216, 220, 223, 234, 240, 252, 267, 272, 276, 301, 302,
  304, 305, 315, 321, 326, 330, 332, 336, 339, 347, 351, 352, 363, 380, 386, 401,
  404, 407, 410, 412, 413, 419, 423, 434, 440, 443, 445, 463, 470, 475, 478, 484,
  502, 508, 513, 516, 517, 518, 540, 551, 561, 567, 570, 571, 574, 582, 585, 586,
  603, 607, 609, 610, 614, 616, 617, 631, 640, 646, 667, 678, 680, 681, 686,
  689, 703, 704, 706, 716, 717, 718, 724, 727, 732, 734, 740, 743, 754, 757, 762,
  765, 770, 772, 774, 781, 786, 802, 803, 804, 810, 812, 813, 814, 826, 828, 835,
  838, 843, 845, 848, 850, 854, 856, 857, 859, 862, 863, 864, 865, 878, 904, 908,
  910, 912, 914, 917, 919, 929, 930, 934, 937, 941, 947, 948, 954, 959, 973, 978,
  980, 984, 989,
];

const CT_CODES = [
  205, 214, 217, 218, 219, 224, 225, 228, 229, 251, 254, 256, 260, 262, 270, 274,
  281, 309, 312, 314, 316, 318, 319, 320, 327, 331, 334, 337, 346, 353, 361, 364, 402,
  405, 409, 414, 417, 430, 432, 447, 469, 479, 483, 501, 504, 507, 512, 515, 531,
  534, 539, 557, 563, 572, 573, 580, 601, 605, 608, 612, 615, 618, 620, 629, 630,
  636, 641, 651, 660, 662, 682, 701, 708, 712, 713, 715, 726, 730, 731, 737, 763,
  769, 773, 779, 785, 806, 815, 816, 817, 832, 847, 870, 872, 901, 903, 913, 918,
  920, 931, 936, 938, 940, 952, 956, 972, 975, 979, 985,
];

const MT_CODES = [
  208, 303, 307, 308, 385, 406, 435, 505, 575, 720, 801, 915, 970, 983, 986,
];

const PT_CODES = [
  206, 209, 213, 253, 279, 310, 323, 341, 350, 360, 408, 415, 424, 425, 442, 458,
  503, 510, 530, 541, 559, 562, 564, 619, 626, 628, 650, 657, 661, 669, 702, 707,
  714, 725, 747, 760, 775, 805, 818, 820, 831, 858, 909, 916, 925, 949, 951,
  971,
];

for (const c of ET_CODES) AREA_CODE_TZ[c] = ET;
for (const c of CT_CODES) AREA_CODE_TZ[c] = CT;
for (const c of MT_CODES) AREA_CODE_TZ[c] = MT;
for (const c of PT_CODES) AREA_CODE_TZ[c] = PT;

export function areaCodeToTimezone(areaCode: number | string | null | undefined): string | null {
  if (areaCode == null) return null;
  const n = typeof areaCode === "number" ? areaCode : parseInt(String(areaCode), 10);
  if (!Number.isFinite(n)) return null;
  return AREA_CODE_TZ[n] ?? null;
}
