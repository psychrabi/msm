use std::{fs, path::Path};

const PREFIX: &str = "MSM-DPAPI-1:";

pub fn load_or_create_secret(path: &Path) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if let Ok(contents) = fs::read_to_string(path) {
        let contents = contents.trim();
        if let Some(encoded) = contents.strip_prefix(PREFIX) {
            let protected = hex_decode(encoded)?;
            #[cfg(windows)] {
                return Ok(String::from_utf8(unprotect_machine(&protected)?)?);
            }
            #[cfg(not(windows))] {
                return Err("DPAPI-protected agent token cannot be read on non-Windows".into());
            }
        }
        if !contents.is_empty() {
            // Migrate the legacy plaintext token immediately.
            let protected = protect_machine(contents.as_bytes())?;
            write_secret(path, &protected)?;
            return Ok(contents.to_owned());
        }
    }

    let token = uuid::Uuid::new_v4().to_string();
    let protected = protect_machine(token.as_bytes())?;
    write_secret(path, &protected)?;
    Ok(token)
}

fn write_secret(path: &Path, protected: &[u8]) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{PREFIX}{}\n", hex_encode(protected)))?;
    Ok(())
}

#[cfg(windows)]
fn protect_machine(plaintext: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN,
        CryptProtectData,
    };
    use windows::core::PCWSTR;

    let input = CRYPT_INTEGER_BLOB { cbData: plaintext.len() as u32, pbData: plaintext.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, PCWSTR::null(), None, None, None, CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN, &mut output)?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(bytes)
    }
}

#[cfg(windows)]
fn unprotect_machine(protected: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN,
        CryptUnprotectData,
    };
    let input = CRYPT_INTEGER_BLOB { cbData: protected.len() as u32, pbData: protected.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN, &mut output)?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn protect_machine(_plaintext: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    Err("Windows DPAPI is required for the agent token".into())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn hex_decode(value: &str) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    if value.len() % 2 != 0 { return Err("invalid DPAPI token encoding".into()); }
    let mut out = Vec::with_capacity(value.len() / 2);
    for chunk in value.as_bytes().chunks_exact(2) {
        let hi = (chunk[0] as char).to_digit(16).ok_or("invalid DPAPI token encoding")?;
        let lo = (chunk[1] as char).to_digit(16).ok_or("invalid DPAPI token encoding")?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip() {
        let value = b"MSM token";
        assert_eq!(hex_decode(&hex_encode(value)).unwrap(), value);
    }
}
