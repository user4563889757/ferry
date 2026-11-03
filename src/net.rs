use std::net::IpAddr;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Interface {
    pub name: String,
    pub address: String,
    pub url: String,
    pub bluetooth: bool,
}

pub fn interfaces(bind: IpAddr, port: u16) -> Vec<Interface> {
    if !bind.is_unspecified() {
        return vec![Interface {
            name: "bound address".to_string(),
            address: bind.to_string(),
            url: origin(bind, port),
            bluetooth: false,
        }];
    }

    let mut found = Vec::new();
    if let Ok(addresses) = if_addrs::get_if_addrs() {
        for interface in addresses {
            if interface.is_loopback() {
                continue;
            }
            let std::net::IpAddr::V4(address) = interface.addr.ip() else {
                continue;
            };
            if address.is_link_local() || address.is_unspecified() {
                continue;
            }
            let name = interface.name.clone();
            found.push(Interface {
                bluetooth: is_bluetooth_interface(&name),
                name,
                address: address.to_string(),
                url: origin(IpAddr::V4(address), port),
            });
        }
    }

    found.sort_by(|a, b| {
        a.bluetooth
            .cmp(&b.bluetooth)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.address.cmp(&b.address))
    });

    if found.is_empty() {
        found.push(Interface {
            name: "loopback".to_string(),
            address: "127.0.0.1".to_string(),
            url: origin(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), port),
            bluetooth: false,
        });
    }
    found
}

pub fn is_bluetooth_interface(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("bnep")
        || name.starts_with("bt-pan")
        || name.starts_with("pan")
        || name.contains("bluetooth")
}

pub fn origin(address: IpAddr, port: u16) -> String {
    match address {
        IpAddr::V4(address) => format!("http://{address}:{port}/"),
        IpAddr::V6(address) => format!("http://[{address}]:{port}/"),
    }
}

pub fn device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|name| name.into_string().ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "This device".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_bluetooth_pan_names() {
        assert!(is_bluetooth_interface("bnep0"));
        assert!(is_bluetooth_interface("bt-pan"));
        assert!(is_bluetooth_interface("Bluetooth Network Connection"));
        assert!(!is_bluetooth_interface("wlan0"));
    }

    #[test]
    fn formats_ipv4_and_ipv6_origins() {
        assert_eq!(
            origin("192.168.1.4".parse().unwrap(), 8787),
            "http://192.168.1.4:8787/"
        );
        assert_eq!(
            origin("::1".parse().unwrap(), 8787),
            "http://[::1]:8787/"
        );
    }
}
