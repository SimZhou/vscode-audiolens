use std::f32::consts::PI;

pub mod pcm;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WindowFunction {
    Rectangular,
    Bartlett,
    Hamming,
    Hann,
    Blackman,
    BlackmanHarris,
    Welch,
    Gaussian25,
    Gaussian35,
    Gaussian45,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FrequencyScale {
    Linear,
    Log,
    Mel,
    Bark,
    Erb,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpectrogramPalette {
    Rose,
    Classic,
    Grayscale,
    InverseGrayscale,
}

#[derive(Clone, Copy, Debug)]
pub struct SpectrogramSettings {
    pub window_function: WindowFunction,
    pub fft_size: usize,
    pub zero_padding_factor: usize,
    pub hop_size: usize,
    pub output_bins: usize,
    pub sample_rate: f32,
    pub min_db: f32,
    pub max_db: f32,
    pub frequency_scale: FrequencyScale,
    pub palette: SpectrogramPalette,
}

#[derive(Clone, Debug)]
pub struct SpectrogramImage {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
}

pub fn render_spectrogram(samples: &[f32], settings: SpectrogramSettings) -> SpectrogramImage {
    let window_size = settings.fft_size.max(8);
    let zero_padding_factor = settings.zero_padding_factor.max(1);
    let fft_size = next_power_of_two(window_size * zero_padding_factor);
    let sample_rate = settings.sample_rate.max(1.0);
    let hop_size = settings.hop_size.max(1);
    let bins = settings.output_bins.max(1).min(fft_size / 2);
    let frames = samples.len().saturating_sub(window_size) / hop_size + 1;
    let mut pixels = vec![0; frames * bins * 4];
    let window = create_window(settings.window_function, window_size);
    let nyquist = sample_rate / 2.0;
    let min_db = settings.min_db;
    let max_db = settings.max_db.max(min_db + 1.0);
    let mut re = vec![0.0; fft_size];
    let mut im = vec![0.0; fft_size];

    for frame in 0..frames {
        let offset = frame * hop_size;
        re.fill(0.0);
        im.fill(0.0);

        for i in 0..window_size {
            re[i] = samples.get(offset + i).copied().unwrap_or(0.0) * window[i];
        }

        fft(&mut re, &mut im);

        for y in 0..bins {
            let ratio = if bins <= 1 {
                0.0
            } else {
                (bins - 1 - y) as f32 / (bins - 1) as f32
            };
            let freq = frequency_from_ratio(ratio, settings.frequency_scale, nyquist);
            let bin = ((freq / sample_rate) * fft_size as f32)
                .round()
                .clamp(0.0, (fft_size / 2 - 1) as f32) as usize;
            let mag = (re[bin] * re[bin] + im[bin] * im[bin]).sqrt() / window_size as f32;
            let db = 20.0 * mag.max(1e-12).log10();
            let color = colorize((db - min_db) / (max_db - min_db), settings.palette);
            let index = (y * frames + frame) * 4;
            pixels[index] = color[0];
            pixels[index + 1] = color[1];
            pixels[index + 2] = color[2];
            pixels[index + 3] = 255;
        }
    }

    SpectrogramImage {
        width: frames,
        height: bins,
        pixels,
    }
}

fn create_window(window_function: WindowFunction, size: usize) -> Vec<f32> {
    let denom = size.saturating_sub(1).max(1) as f32;
    let center = denom / 2.0;
    (0..size)
        .map(|i| {
            let phase = (2.0 * PI * i as f32) / denom;
            let x = if center == 0.0 {
                0.0
            } else {
                (i as f32 - center) / center
            };
            match window_function {
                WindowFunction::Rectangular => 1.0,
                WindowFunction::Bartlett => 1.0 - x.abs(),
                WindowFunction::Hamming => 0.54 - 0.46 * phase.cos(),
                WindowFunction::Hann => 0.5 - 0.5 * phase.cos(),
                WindowFunction::Blackman => 0.42 - 0.5 * phase.cos() + 0.08 * (2.0 * phase).cos(),
                WindowFunction::BlackmanHarris => {
                    0.35875 - 0.48829 * phase.cos() + 0.14128 * (2.0 * phase).cos()
                        - 0.01168 * (3.0 * phase).cos()
                }
                WindowFunction::Welch => 1.0 - x * x,
                WindowFunction::Gaussian25 => (-0.5 * (2.5 * x).powi(2)).exp(),
                WindowFunction::Gaussian35 => (-0.5 * (3.5 * x).powi(2)).exp(),
                WindowFunction::Gaussian45 => (-0.5 * (4.5 * x).powi(2)).exp(),
            }
        })
        .collect()
}

fn next_power_of_two(value: usize) -> usize {
    value.next_power_of_two().max(1)
}

fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }

    let mut len = 2;
    while len <= n {
        let angle = (-2.0 * PI) / len as f32;
        let w_len_r = angle.cos();
        let w_len_i = angle.sin();
        let half = len / 2;

        for i in (0..n).step_by(len) {
            let mut wr = 1.0;
            let mut wi = 0.0;
            for j in 0..half {
                let u_r = re[i + j];
                let u_i = im[i + j];
                let v_r = re[i + j + half] * wr - im[i + j + half] * wi;
                let v_i = re[i + j + half] * wi + im[i + j + half] * wr;
                re[i + j] = u_r + v_r;
                im[i + j] = u_i + v_i;
                re[i + j + half] = u_r - v_r;
                im[i + j + half] = u_i - v_i;
                let next_wr = wr * w_len_r - wi * w_len_i;
                wi = wr * w_len_i + wi * w_len_r;
                wr = next_wr;
            }
        }

        len <<= 1;
    }
}

fn frequency_from_ratio(ratio: f32, scale: FrequencyScale, nyquist: f32) -> f32 {
    let r = ratio.clamp(0.0, 1.0);
    let top = nyquist.max(1.0);
    match scale {
        FrequencyScale::Linear => r * top,
        FrequencyScale::Log => {
            if r <= 0.0 {
                0.0
            } else {
                let low = 20.0;
                (low * (top / low).powf(r)).min(top)
            }
        }
        FrequencyScale::Mel => mel_to_hz(r * hz_to_mel(top)),
        FrequencyScale::Bark => bark_to_hz(r * hz_to_bark(top)),
        FrequencyScale::Erb => erb_to_hz(r * hz_to_erb(top)),
    }
}

fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10.0_f32.powf(mel / 2595.0) - 1.0)
}

fn hz_to_bark(hz: f32) -> f32 {
    6.0 * (hz / 600.0).asinh()
}

fn bark_to_hz(bark: f32) -> f32 {
    600.0 * (bark / 6.0).sinh()
}

fn hz_to_erb(hz: f32) -> f32 {
    21.4 * (1.0 + 0.00437 * hz).log10()
}

fn erb_to_hz(erb: f32) -> f32 {
    (10.0_f32.powf(erb / 21.4) - 1.0) / 0.00437
}

fn colorize(value: f32, palette: SpectrogramPalette) -> [u8; 3] {
    let t = value.clamp(0.0, 1.0);
    match palette {
        SpectrogramPalette::Grayscale => {
            let v = (t * 255.0).round() as u8;
            [v, v, v]
        }
        SpectrogramPalette::InverseGrayscale => {
            let v = ((1.0 - t) * 255.0).round() as u8;
            [v, v, v]
        }
        SpectrogramPalette::Rose => {
            if t < 0.25 {
                lerp([12, 10, 24], [52, 25, 82], t / 0.25)
            } else if t < 0.5 {
                lerp([52, 25, 82], [165, 43, 108], (t - 0.25) / 0.25)
            } else if t < 0.75 {
                lerp([165, 43, 108], [241, 118, 92], (t - 0.5) / 0.25)
            } else {
                lerp([241, 118, 92], [255, 224, 140], (t - 0.75) / 0.25)
            }
        }
        SpectrogramPalette::Classic => {
            if t < 0.25 {
                lerp([12, 18, 28], [25, 86, 134], t / 0.25)
            } else if t < 0.5 {
                lerp([25, 86, 134], [40, 160, 115], (t - 0.25) / 0.25)
            } else if t < 0.75 {
                lerp([40, 160, 115], [230, 174, 55], (t - 0.5) / 0.25)
            } else {
                lerp([230, 174, 55], [235, 77, 75], (t - 0.75) / 0.25)
            }
        }
    }
}

fn lerp(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
    [
        (a[0] as f32 + (b[0] as f32 - a[0] as f32) * t).round() as u8,
        (a[1] as f32 + (b[1] as f32 - a[1] as f32) * t).round() as u8,
        (a[2] as f32 + (b[2] as f32 - a[2] as f32) * t).round() as u8,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_settings() -> SpectrogramSettings {
        SpectrogramSettings {
            window_function: WindowFunction::Hann,
            fft_size: 64,
            zero_padding_factor: 1,
            hop_size: 32,
            output_bins: 32,
            sample_rate: 1024.0,
            min_db: -96.0,
            max_db: 0.0,
            frequency_scale: FrequencyScale::Linear,
            palette: SpectrogramPalette::Grayscale,
        }
    }

    #[test]
    fn spectrogram_has_expected_dimensions_and_alpha() {
        let samples = vec![0.0; 128];
        let image = render_spectrogram(&samples, default_settings());

        assert_eq!(image.width, 3);
        assert_eq!(image.height, 32);
        assert_eq!(image.pixels.len(), image.width * image.height * 4);
        assert!(image.pixels.chunks_exact(4).all(|rgba| rgba[3] == 255));
    }

    #[test]
    fn sine_tone_produces_visible_energy() {
        let sample_rate = 1024.0;
        let samples: Vec<f32> = (0..128)
            .map(|i| (2.0 * PI * 128.0 * i as f32 / sample_rate).sin())
            .collect();
        let image = render_spectrogram(&samples, default_settings());

        assert!(image.pixels.chunks_exact(4).any(|rgba| rgba[0] > 80));
    }
}
