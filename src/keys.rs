use std::fmt;

/// Position on the Camelot wheel. `hour` is 1..=12, `major` distinguishes B
/// (major, outer ring) from A (minor, inner ring).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Camelot {
    pub hour: u8,
    pub major: bool,
}

impl fmt::Display for Camelot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{}", self.hour, if self.major { 'B' } else { 'A' })
    }
}

impl Camelot {
    /// Parse tonality strings in any of the three forms Rekordbox may export:
    /// Camelot (`8A`, `11B`), Mixed-In-Key open-key (`8m`, `5d`), or classical
    /// note names (`Am`, `F#m`, `Bb`, `C`).
    pub fn parse(s: &str) -> Option<Camelot> {
        let s = s.trim();
        if s.is_empty() {
            return None;
        }
        parse_camelot_raw(s)
            .or_else(|| parse_open_key(s))
            .or_else(|| parse_classical(s))
    }

    /// Open Key (Traktor, `1d` = C major, `1m` = A minor) is the Camelot wheel
    /// rotated by six hours: Camelot hour = (open + 6) mod 12 + 1.
    pub fn from_open_key(open: u8, major: bool) -> Option<Camelot> {
        if !(1..=12).contains(&open) {
            return None;
        }
        Some(Camelot {
            hour: (open + 6) % 12 + 1,
            major,
        })
    }

    /// Inverse of [`Camelot::from_open_key`], formatted like Traktor writes it.
    pub fn to_open_key(&self) -> String {
        let open = (self.hour + 5) % 12;
        let open = if open == 0 { 12 } else { open };
        format!("{}{}", open, if self.major { 'd' } else { 'm' })
    }

    /// Tonic as a pitch class (C = 0 … B = 11) plus mode.
    pub fn tonic(&self) -> (u8, bool) {
        // Major tonic with Camelot hour h: pc = 7·(h + 4) mod 12 (7 is its own
        // inverse mod 12). A minor key shares its relative major's hour, and
        // its tonic sits three semitones below the major tonic.
        let major_pc = (7 * (self.hour as u32 + 4) % 12) as u8;
        if self.major {
            (major_pc, true)
        } else {
            ((major_pc + 9) % 12, false)
        }
    }

    /// Camelot position for a tonic pitch class (C = 0) and mode.
    pub fn from_tonic(pc: u8, major: bool) -> Camelot {
        let major_pc = if major { pc % 12 } else { (pc % 12 + 3) % 12 } as u32;
        Camelot {
            hour: ((7 * major_pc + 7) % 12 + 1) as u8,
            major,
        }
    }

    /// Classical name ("Am", "F#m", "Bb") using flats for black keys, which is
    /// how DJ software conventionally spells them.
    pub fn to_classical(&self) -> String {
        const NAMES: [&str; 12] = [
            "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
        ];
        let (pc, major) = self.tonic();
        format!("{}{}", NAMES[pc as usize], if major { "" } else { "m" })
    }

    /// Camelot mixing rule: same key, neighbour on the wheel (±1 hour, same
    /// letter), or relative major/minor (same hour, opposite letter).
    pub fn compatible(&self, other: &Camelot) -> bool {
        if self == other {
            return true;
        }
        if self.hour == other.hour && self.major != other.major {
            return true;
        }
        if self.major == other.major && hour_delta(self.hour, other.hour) == 1 {
            return true;
        }
        false
    }
}

fn hour_delta(a: u8, b: u8) -> u8 {
    let d = if a > b { a - b } else { b - a };
    d.min(12 - d)
}

fn parse_camelot_raw(s: &str) -> Option<Camelot> {
    let last = s.chars().last()?;
    let major = match last {
        'A' | 'a' => false,
        'B' | 'b' => true,
        _ => return None,
    };
    let hour: u8 = s[..s.len() - 1].parse().ok()?;
    (1..=12).contains(&hour).then_some(Camelot { hour, major })
}

fn parse_open_key(s: &str) -> Option<Camelot> {
    let last = s.chars().last()?;
    let major = match last {
        'd' | 'D' => true,
        'm' => false,
        _ => return None,
    };
    let open: u8 = s[..s.len() - 1].parse().ok()?;
    Camelot::from_open_key(open, major)
}

fn parse_classical(s: &str) -> Option<Camelot> {
    let (root, minor) = if let Some(r) = s.strip_suffix("min") {
        (r, true)
    } else if let Some(r) = s.strip_suffix("maj") {
        (r, false)
    } else if let Some(r) = s.strip_suffix('m') {
        (r, true)
    } else if let Some(r) = s.strip_suffix('M') {
        (r, false)
    } else {
        (s, false)
    };
    let normalized = root.replace('♯', "#").replace('♭', "b");
    let key = normalized.trim();
    let hour = if minor {
        match key {
            "Ab" | "G#" => 1,
            "Eb" | "D#" => 2,
            "Bb" | "A#" => 3,
            "F" => 4,
            "C" => 5,
            "G" => 6,
            "D" => 7,
            "A" => 8,
            "E" => 9,
            "B" => 10,
            "F#" | "Gb" => 11,
            "C#" | "Db" => 12,
            _ => return None,
        }
    } else {
        match key {
            "B" => 1,
            "F#" | "Gb" => 2,
            "C#" | "Db" => 3,
            "Ab" | "G#" => 4,
            "Eb" | "D#" => 5,
            "Bb" | "A#" => 6,
            "F" => 7,
            "C" => 8,
            "G" => 9,
            "D" => 10,
            "A" => 11,
            "E" => 12,
            _ => return None,
        }
    };
    Some(Camelot {
        hour,
        major: !minor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_camelot_direct() {
        assert_eq!(
            Camelot::parse("8A"),
            Some(Camelot {
                hour: 8,
                major: false
            })
        );
        assert_eq!(
            Camelot::parse("11B"),
            Some(Camelot {
                hour: 11,
                major: true
            })
        );
    }

    #[test]
    fn parses_classical() {
        assert_eq!(
            Camelot::parse("Am"),
            Some(Camelot {
                hour: 8,
                major: false
            })
        );
        assert_eq!(
            Camelot::parse("C"),
            Some(Camelot {
                hour: 8,
                major: true
            })
        );
        assert_eq!(
            Camelot::parse("F#m"),
            Some(Camelot {
                hour: 11,
                major: false
            })
        );
        assert_eq!(
            Camelot::parse("Bb"),
            Some(Camelot {
                hour: 6,
                major: true
            })
        );
    }

    #[test]
    fn parses_open_key() {
        // Open Key 1m = A minor = Camelot 8A; 1d = C major = Camelot 8B.
        assert_eq!(
            Camelot::parse("1m"),
            Some(Camelot {
                hour: 8,
                major: false
            })
        );
        assert_eq!(
            Camelot::parse("1d"),
            Some(Camelot {
                hour: 8,
                major: true
            })
        );
        assert_eq!(
            Camelot::parse("8m"),
            Some(Camelot {
                hour: 3,
                major: false
            })
        );
        assert_eq!(
            Camelot::parse("12d"),
            Some(Camelot {
                hour: 7,
                major: true
            })
        );
    }

    #[test]
    fn open_key_round_trips_for_every_position() {
        for hour in 1..=12u8 {
            for major in [false, true] {
                let c = Camelot { hour, major };
                assert_eq!(Camelot::parse(&c.to_open_key()), Some(c), "{}", c);
            }
        }
    }

    #[test]
    fn tonic_and_classical_names_agree_with_the_wheel() {
        let am = Camelot::parse("Am").unwrap();
        assert_eq!(am.tonic(), (9, false));
        assert_eq!(am.to_classical(), "Am");
        assert_eq!(Camelot::parse("C").unwrap().tonic(), (0, true));
        assert_eq!(Camelot::from_tonic(9, false), am);
        for hour in 1..=12u8 {
            for major in [false, true] {
                let c = Camelot { hour, major };
                let (pc, m) = c.tonic();
                assert_eq!(Camelot::from_tonic(pc, m), c);
                assert_eq!(Camelot::parse(&c.to_classical()), Some(c));
            }
        }
    }

    #[test]
    fn compatibility_rules() {
        let am = Camelot {
            hour: 8,
            major: false,
        };
        let c_major = Camelot {
            hour: 8,
            major: true,
        }; // relative
        let em = Camelot {
            hour: 9,
            major: false,
        }; // +1 same letter
        let dm = Camelot {
            hour: 7,
            major: false,
        }; // -1 same letter
        let far = Camelot {
            hour: 2,
            major: false,
        };
        assert!(am.compatible(&c_major));
        assert!(am.compatible(&em));
        assert!(am.compatible(&dm));
        assert!(!am.compatible(&far));
    }
}
