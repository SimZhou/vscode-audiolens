#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PcmSampleFormat {
    SignedInt,
    Float,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PcmEndianness {
    Little,
    Big,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PcmGuessSource {
    Content,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PcmFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub bit_depth: u16,
    pub sample_format: PcmSampleFormat,
    pub endianness: PcmEndianness,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PcmFormatCandidate {
    pub format: PcmFormat,
    pub confidence: f32,
    pub source: PcmGuessSource,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PcmDecodedAudio {
    pub sample_rate: u32,
    pub channels: u16,
    pub frames: usize,
    pub samples: Vec<Vec<f32>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PcmDecodeError {
    InvalidFormat,
    UnalignedBytes,
}

const COMMON_SAMPLE_RATES: [u32; 9] = [16000, 8000, 44100, 48000, 11025, 22050, 24000, 32000, 96000];
const COMMON_CHANNELS: [u16; 8] = [1, 2, 3, 4, 6, 8, 12, 16];

pub fn detect_pcm_format(file_name: &str, bytes: &[u8]) -> Vec<PcmFormatCandidate> {
    let _ = file_name;
    let mut candidates = Vec::new();

    for sample_rate in COMMON_SAMPLE_RATES {
        for channels in COMMON_CHANNELS {
            for bit_depth in [16, 24, 32, 8] {
                for sample_format in [PcmSampleFormat::SignedInt, PcmSampleFormat::Float] {
                    if sample_format == PcmSampleFormat::Float && bit_depth != 32 {
                        continue;
                    }
                    for endianness in [PcmEndianness::Little, PcmEndianness::Big] {
                        let format = PcmFormat {
                            sample_rate,
                            channels,
                            bit_depth,
                            sample_format,
                            endianness,
                        };
                        if frame_size(&format).is_none_or(|size| size == 0 || bytes.len() % size != 0) {
                            continue;
                        }
                        let confidence = score_content(bytes, &format);
                        candidates.push(PcmFormatCandidate {
                            format,
                            confidence,
                            source: PcmGuessSource::Content,
                        });
                    }
                }
            }
        }
    }

    candidates.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| format_rank(&a.format).cmp(&format_rank(&b.format)))
    });
    diversify_candidates(candidates, 8)
}

pub fn decode_pcm(bytes: &[u8], format: &PcmFormat) -> Result<PcmDecodedAudio, PcmDecodeError> {
    let bytes_per_sample = bytes_per_sample(format).ok_or(PcmDecodeError::InvalidFormat)?;
    let frame_size = bytes_per_sample
        .checked_mul(format.channels as usize)
        .ok_or(PcmDecodeError::InvalidFormat)?;
    if frame_size == 0 || bytes.len() % frame_size != 0 {
        return Err(PcmDecodeError::UnalignedBytes);
    }

    let frames = bytes.len() / frame_size;
    let mut samples = vec![Vec::with_capacity(frames); format.channels as usize];
    for frame in 0..frames {
        let frame_offset = frame * frame_size;
        for channel in 0..format.channels as usize {
            let offset = frame_offset + channel * bytes_per_sample;
            samples[channel].push(read_sample(&bytes[offset..offset + bytes_per_sample], format));
        }
    }

    Ok(PcmDecodedAudio {
        sample_rate: format.sample_rate,
        channels: format.channels,
        frames,
        samples,
    })
}

fn score_content(bytes: &[u8], format: &PcmFormat) -> f32 {
    let Ok(decoded) = decode_pcm(sample_window(bytes, format), format) else {
        return 0.0;
    };
    if decoded.frames == 0 {
        return 0.0;
    }

    let mut score = format_prior(format);
    for channel in &decoded.samples {
        let measured = channel.len().max(1) as f32;
        let mut peak = 0.0_f32;
        let mut sum = 0.0_f32;
        let mut zeroish = 0;
        let mut clipped = 0;
        let mut non_finite = 0;
        for value in channel {
            if !value.is_finite() {
                non_finite += 1;
                continue;
            }
            let abs = value.abs();
            peak = peak.max(abs);
            sum += value * value;
            if abs < 1e-6 {
                zeroish += 1;
            }
            if abs >= 0.999 {
                clipped += 1;
            }
        }
        let rms = (sum / measured).sqrt();
        let zero_ratio = zeroish as f32 / measured;
        let clipped_ratio = clipped as f32 / measured;
        let bad_ratio = non_finite as f32 / measured;

        if bad_ratio > 0.0 {
            score -= 0.5;
        }
        if peak > 0.001 && peak <= 1.05 {
            score += 0.18;
        }
        if rms > 0.0001 && rms < 0.75 {
            score += 0.16;
        }
        if zero_ratio < 0.95 {
            score += 0.08;
        }
        if clipped_ratio < 0.10 {
            score += 0.10;
        }
    }
    (score / format.channels as f32).clamp(0.0, 1.0)
}

fn sample_window<'a>(bytes: &'a [u8], format: &PcmFormat) -> &'a [u8] {
    let Some(frame_size) = frame_size(format) else {
        return bytes;
    };
    let max_frames = 48_000usize.min(bytes.len() / frame_size);
    &bytes[..max_frames * frame_size]
}

fn read_sample(bytes: &[u8], format: &PcmFormat) -> f32 {
    match (format.sample_format, format.bit_depth, format.endianness) {
        (PcmSampleFormat::Float, 32, PcmEndianness::Little) => {
            f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]).clamp(-1.0, 1.0)
        }
        (PcmSampleFormat::Float, 32, PcmEndianness::Big) => {
            f32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]).clamp(-1.0, 1.0)
        }
        (PcmSampleFormat::SignedInt, 8, _) => (bytes[0] as i8) as f32 / 128.0,
        (PcmSampleFormat::SignedInt, 16, PcmEndianness::Little) => {
            i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0
        }
        (PcmSampleFormat::SignedInt, 16, PcmEndianness::Big) => {
            i16::from_be_bytes([bytes[0], bytes[1]]) as f32 / 32768.0
        }
        (PcmSampleFormat::SignedInt, 24, PcmEndianness::Little) => {
            sign_extend_24((bytes[0] as i32) | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16)) as f32 / 8_388_608.0
        }
        (PcmSampleFormat::SignedInt, 24, PcmEndianness::Big) => {
            sign_extend_24((bytes[2] as i32) | ((bytes[1] as i32) << 8) | ((bytes[0] as i32) << 16)) as f32 / 8_388_608.0
        }
        (PcmSampleFormat::SignedInt, 32, PcmEndianness::Little) => {
            i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2_147_483_648.0
        }
        (PcmSampleFormat::SignedInt, 32, PcmEndianness::Big) => {
            i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2_147_483_648.0
        }
        _ => 0.0,
    }
}

fn sign_extend_24(value: i32) -> i32 {
    if value & 0x80_0000 != 0 {
        value | !0xFF_FFFF
    } else {
        value
    }
}

fn frame_size(format: &PcmFormat) -> Option<usize> {
    bytes_per_sample(format).map(|bytes| bytes * format.channels as usize)
}

fn bytes_per_sample(format: &PcmFormat) -> Option<usize> {
    match (format.sample_format, format.bit_depth) {
        (PcmSampleFormat::SignedInt, 8 | 16 | 24 | 32) => Some(format.bit_depth as usize / 8),
        (PcmSampleFormat::Float, 32) => Some(4),
        _ => None,
    }
}

fn format_prior(format: &PcmFormat) -> f32 {
    let mut score = 0.2;
    if format.sample_format == PcmSampleFormat::SignedInt {
        score += 0.08;
    }
    match format.bit_depth {
        16 => score += 0.12,
        24 => score += 0.06,
        _ => {}
    }
    if format.endianness == PcmEndianness::Little {
        score += 0.08;
    }
    if format.sample_rate == 16000 {
        score += 0.08;
    } else if format.sample_rate == 8000 || format.sample_rate == 48000 {
        score += 0.04;
    }
    score
}

fn format_rank(format: &PcmFormat) -> usize {
    let sample_rate_rank = COMMON_SAMPLE_RATES
        .iter()
        .position(|value| *value == format.sample_rate)
        .unwrap_or(COMMON_SAMPLE_RATES.len());
    let channel_rank = COMMON_CHANNELS
        .iter()
        .position(|value| *value == format.channels)
        .unwrap_or(COMMON_CHANNELS.len());
    let bit_rank = match format.bit_depth {
        16 => 0,
        24 => 1,
        32 => 2,
        8 => 3,
        _ => 4,
    };
    let endian_rank = match format.endianness {
        PcmEndianness::Little => 0,
        PcmEndianness::Big => 1,
    };
    sample_rate_rank * 1000 + channel_rank * 100 + bit_rank * 10 + endian_rank
}

fn diversify_candidates(candidates: Vec<PcmFormatCandidate>, limit: usize) -> Vec<PcmFormatCandidate> {
    let mut selected = Vec::new();
    let mut signatures = Vec::<(u16, u16, PcmSampleFormat, PcmEndianness, u32)>::new();
    if let Some(candidate) = candidates.first() {
        add_candidate(candidate.clone(), limit, &mut selected, &mut signatures);
    }
    for channels in COMMON_CHANNELS {
        if let Some(candidate) = candidates.iter().find(|candidate| candidate.format.channels == channels) {
            add_candidate(candidate.clone(), limit, &mut selected, &mut signatures);
        }
        if selected.len() >= ((limit * 3) + 3) / 4 {
            break;
        }
    }
    for candidate in candidates {
        add_candidate(candidate, limit, &mut selected, &mut signatures);
        if selected.len() >= limit {
            break;
        }
    }
    selected
}

fn add_candidate(
    candidate: PcmFormatCandidate,
    limit: usize,
    selected: &mut Vec<PcmFormatCandidate>,
    signatures: &mut Vec<(u16, u16, PcmSampleFormat, PcmEndianness, u32)>,
) {
    if selected.len() >= limit {
        return;
    }
        let signature = (
            candidate.format.channels,
            candidate.format.bit_depth,
            candidate.format.sample_format,
            candidate.format.endianness,
            candidate.format.sample_rate,
        );
        if !signatures.contains(&signature) {
            signatures.push(signature);
            selected.push(candidate);
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_candidates_prefer_common_s16le() {
        let bytes = make_s16le_sine(16_000, 3, 400);
        let candidates = detect_pcm_format("opaque.pcm", &bytes);
        let best = &candidates[0].format;

        assert_eq!(best.sample_rate, 16_000);
        assert_eq!(best.bit_depth, 16);
        assert_eq!(best.sample_format, PcmSampleFormat::SignedInt);
        assert_eq!(best.endianness, PcmEndianness::Little);
    }

    #[test]
    fn content_candidates_include_multiple_channel_choices() {
        let bytes = make_s16le_sine(16_000, 3, 400);
        let candidates = detect_pcm_format("opaque.pcm", &bytes);

        assert!(candidates.iter().any(|candidate| candidate.format.channels == 1));
        assert!(candidates.iter().any(|candidate| candidate.format.channels == 2 || candidate.format.channels == 3));
    }

    #[test]
    fn decode_s16le_interleaved_channels() {
        let format = PcmFormat {
            sample_rate: 16_000,
            channels: 2,
            bit_depth: 16,
            sample_format: PcmSampleFormat::SignedInt,
            endianness: PcmEndianness::Little,
        };
        let bytes = [0_i16, 32767, -32768, 16384]
            .into_iter()
            .flat_map(i16::to_le_bytes)
            .collect::<Vec<_>>();

        let decoded = decode_pcm(&bytes, &format).unwrap();

        assert_eq!(decoded.frames, 2);
        assert_eq!(decoded.samples[0], vec![0.0, -1.0]);
        assert!((decoded.samples[1][0] - 0.9999695).abs() < 1e-6);
        assert_eq!(decoded.samples[1][1], 0.5);
    }

    #[test]
    fn rejects_unaligned_bytes() {
        let format = PcmFormat {
            sample_rate: 16_000,
            channels: 2,
            bit_depth: 16,
            sample_format: PcmSampleFormat::SignedInt,
            endianness: PcmEndianness::Little,
        };

        assert_eq!(decode_pcm(&[0, 1, 2], &format), Err(PcmDecodeError::UnalignedBytes));
    }

    fn make_s16le_sine(sample_rate: u32, channels: u16, frames: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        for frame in 0..frames {
            for channel in 0..channels {
                let phase = frame as f32 / sample_rate as f32 * 440.0 * std::f32::consts::TAU;
                let value = (phase.sin() * (10_000.0 + channel as f32 * 100.0)) as i16;
                bytes.extend(value.to_le_bytes());
            }
        }
        bytes
    }
}
