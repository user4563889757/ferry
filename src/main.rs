use std::env;
use std::error::Error;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use tokio::net::TcpListener;
use uuid::Uuid;

use ferry::api::{self, AppState};
use ferry::net;
use ferry::store::Store;
use ferry::VERSION;

#[derive(Debug, Parser)]
#[command(
    name = "ferry",
    version,
    about = "A tiny, resumable file ferry for your local network",
    after_help = "Files stay on this machine and are served only to clients that know the share key.\n\
                  For Bluetooth, pair both devices and enable Bluetooth tethering/PAN, then use the\n\
                  Bluetooth address printed above."
)]
struct Cli {
    /// Address to listen on
    #[arg(short, long, default_value = "0.0.0.0")]
    bind: IpAddr,

    /// Port to listen on (0 picks a free port)
    #[arg(short, long, default_value_t = 8787)]
    port: u16,

    /// Directory for file metadata and blobs
    #[arg(short, long)]
    dir: Option<PathBuf>,

    /// Fixed share key (default: random for this run)
    #[arg(short = 'k', long)]
    key: Option<String>,

    /// Friendly device name shown to other devices
    #[arg(long)]
    name: Option<String>,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("ferry: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();

    let directory = cli.dir.unwrap_or_else(default_data_dir);
    let store = Store::open(&directory).await?;

    let listener = TcpListener::bind(SocketAddr::new(cli.bind, cli.port)).await?;
    let port = listener.local_addr()?.port();

    let key = match cli.key {
        Some(key) => {
            let key = key.trim().to_string();
            if key.is_empty() {
                return Err("the share key cannot be empty".into());
            }
            if key.chars().any(char::is_control) {
                return Err("the share key cannot contain control characters".into());
            }
            if key.chars().count() > 128 {
                return Err("the share key must be 128 characters or fewer".into());
            }
            key
        }
        None => Uuid::new_v4().simple().to_string()[..16].to_string(),
    };

    let device_name = cli.name.unwrap_or_else(net::device_name);
    let interfaces = net::interfaces(cli.bind, port);
    let state = AppState {
        store: Arc::new(store),
        key: Arc::from(key.as_str()),
        device_name: Arc::from(device_name.as_str()),
        interfaces: Arc::new(interfaces.clone()),
        started_at: ferry::store::now_secs(),
    };

    println!("Ferry {VERSION} - local file transfer");
    println!("Device: {device_name}");
    println!("Data:   {}", directory.display());
    println!("Key:    {key}");
    println!();
    println!("Open on another device on the same network:");
    for interface in &interfaces {
        let label = if interface.bluetooth {
            " (Bluetooth PAN)"
        } else {
            ""
        };
        println!("  {}{label}", interface.url);
        println!("    {}#key={key}", interface.url);
    }
    println!();
    println!("Press Ctrl+C to stop.");

    let shutdown = async {
        if tokio::signal::ctrl_c().await.is_ok() {
            eprintln!("\nferry: shutting down");
        }
    };

    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

fn default_data_dir() -> PathBuf {
    if let Some(path) = env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return PathBuf::from(path).join("ferry");
    }
    if let Some(home) = env::var_os("HOME").filter(|value| !value.is_empty()) {
        return PathBuf::from(home).join(".local").join("share").join("ferry");
    }
    if let Some(appdata) = env::var_os("APPDATA").filter(|value| !value.is_empty()) {
        return PathBuf::from(appdata).join("Ferry");
    }
    PathBuf::from("ferry-data")
}
