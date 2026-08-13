//! Source RCON client for the Project Zomboid dedicated server.
//!
//! The protocol is the Valve Source RCON one: little-endian length-prefixed
//! packets carrying a request id, a type, and a NUL-terminated body.
//!
//! Connections are opened per command rather than kept alive. PZ drops idle
//! RCON sockets without notice, so a long-lived socket costs a failed command
//! and a reconnect on the next call anyway; callers that poll should cache the
//! result instead of holding the connection.

use std::io;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Packet types we send.
const SERVERDATA_AUTH: i32 = 3;
const SERVERDATA_EXECCOMMAND: i32 = 2;

/// Packet types we receive.
const SERVERDATA_RESPONSE_VALUE: i32 = 0;

/// A failed auth is signalled by the server echoing this request id.
const AUTH_FAILED_ID: i32 = -1;

/// Source RCON caps a packet body at 4096 bytes; refuse anything larger so a
/// desynchronised stream cannot make us allocate arbitrarily.
const MAX_PACKET_SIZE: i32 = 4096 + 16;

/// How long to wait for further packets once the first one has arrived.
///
/// Long replies (`players` on a full server) arrive split across packets. PZ
/// does not implement the empty-packet sentinel trick reliably, so instead of
/// asking for an end marker we read until the server goes quiet.
const DRAIN_IDLE: Duration = Duration::from_millis(150);

#[derive(Debug, thiserror::Error)]
pub enum RconError {
    #[error("failed to connect to RCON at {addr}: {source}")]
    Connect {
        addr: String,
        #[source]
        source: io::Error,
    },

    #[error("RCON connection to {addr} timed out after {}s", timeout.as_secs())]
    Timeout { addr: String, timeout: Duration },

    #[error("RCON authentication was rejected")]
    AuthFailed,

    #[error("RCON password is not configured")]
    NoPassword,

    #[error("malformed RCON packet: {0}")]
    Protocol(String),

    #[error("RCON I/O error: {0}")]
    Io(#[from] io::Error),
}

/// Connection settings for the game server's RCON port.
#[derive(Debug, Clone)]
pub struct RconConfig {
    pub host: String,
    pub port: u16,
    pub password: String,
    pub timeout: Duration,
}

impl RconConfig {
    pub fn addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// An authenticated RCON session.
pub struct RconConnection {
    stream: TcpStream,
    addr: String,
    next_id: i32,
    timeout: Duration,
}

impl RconConnection {
    /// Open a socket to the game server and authenticate.
    pub async fn connect(config: &RconConfig) -> Result<Self, RconError> {
        if config.password.is_empty() {
            return Err(RconError::NoPassword);
        }

        let addr = config.addr();

        let stream = timeout(config.timeout, TcpStream::connect(&addr))
            .await
            .map_err(|_| RconError::Timeout {
                addr: addr.clone(),
                timeout: config.timeout,
            })?
            .map_err(|source| RconError::Connect {
                addr: addr.clone(),
                source,
            })?;

        // Status polling sends one small command and reads one small reply;
        // Nagle would add a round-trip of delay to every one of them.
        stream.set_nodelay(true).ok();

        let mut connection = Self {
            stream,
            addr,
            next_id: 0,
            timeout: config.timeout,
        };

        connection.authenticate(&config.password).await?;

        Ok(connection)
    }

    /// Run a command and return the server's reply body.
    pub async fn command(&mut self, command: &str) -> Result<String, RconError> {
        let id = self.take_id();
        self.send(id, SERVERDATA_EXECCOMMAND, command).await?;

        let first = self.read_packet(self.timeout).await?;
        let mut body = first.body;

        // Drain any continuation packets. A read that times out here means the
        // reply was complete, which is the common case — not an error.
        while let Ok(Ok(packet)) = timeout(DRAIN_IDLE, self.read_packet(DRAIN_IDLE)).await {
            body.push_str(&packet.body);
        }

        Ok(body)
    }

    async fn authenticate(&mut self, password: &str) -> Result<(), RconError> {
        let id = self.take_id();
        self.send(id, SERVERDATA_AUTH, password).await?;

        let first = self.read_packet(self.timeout).await?;

        // Spec order is an empty SERVERDATA_RESPONSE_VALUE followed by the real
        // SERVERDATA_AUTH_RESPONSE. Some builds send only the latter.
        let auth_response = if first.packet_type == SERVERDATA_RESPONSE_VALUE {
            self.read_packet(self.timeout).await?
        } else {
            first
        };

        if auth_response.id == AUTH_FAILED_ID {
            return Err(RconError::AuthFailed);
        }

        Ok(())
    }

    async fn send(&mut self, id: i32, packet_type: i32, body: &str) -> Result<(), RconError> {
        let mut packet = Vec::with_capacity(body.len() + 14);
        let length = (body.len() + 10) as i32;

        packet.extend_from_slice(&length.to_le_bytes());
        packet.extend_from_slice(&id.to_le_bytes());
        packet.extend_from_slice(&packet_type.to_le_bytes());
        packet.extend_from_slice(body.as_bytes());
        packet.extend_from_slice(&[0u8, 0u8]);

        timeout(self.timeout, self.stream.write_all(&packet))
            .await
            .map_err(|_| RconError::Timeout {
                addr: self.addr.clone(),
                timeout: self.timeout,
            })??;

        Ok(())
    }

    async fn read_packet(&mut self, wait: Duration) -> Result<Packet, RconError> {
        let mut length_buf = [0u8; 4];
        timeout(wait, self.stream.read_exact(&mut length_buf))
            .await
            .map_err(|_| RconError::Timeout {
                addr: self.addr.clone(),
                timeout: wait,
            })??;

        let length = i32::from_le_bytes(length_buf);
        if !(10..=MAX_PACKET_SIZE).contains(&length) {
            return Err(RconError::Protocol(format!(
                "packet length {length} out of range"
            )));
        }

        let mut payload = vec![0u8; length as usize];
        timeout(wait, self.stream.read_exact(&mut payload))
            .await
            .map_err(|_| RconError::Timeout {
                addr: self.addr.clone(),
                timeout: wait,
            })??;

        let id = i32::from_le_bytes(payload[0..4].try_into().expect("4 bytes"));
        let packet_type = i32::from_le_bytes(payload[4..8].try_into().expect("4 bytes"));

        // Body runs to the first NUL; a trailing empty string follows it.
        let body_bytes = &payload[8..];
        let end = body_bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(body_bytes.len());

        Ok(Packet {
            id,
            packet_type,
            body: String::from_utf8_lossy(&body_bytes[..end]).into_owned(),
        })
    }

    fn take_id(&mut self) -> i32 {
        self.next_id = self.next_id.wrapping_add(1).max(1);
        self.next_id
    }
}

struct Packet {
    id: i32,
    packet_type: i32,
    body: String,
}

/// Open a connection, run one command, and hang up.
///
/// PZ drops idle RCON sockets, so there is no pool to reuse — a one-shot is
/// the whole session.
pub async fn execute(config: &RconConfig, command: &str) -> Result<String, RconError> {
    let mut connection = RconConnection::connect(config).await?;
    connection.command(command).await
}

/// Parse the reply to the `players` command into usernames.
///
/// PZ answers with `Players connected (N):` followed by one `-name` per line.
/// A reply without that header means the command was not understood, which is
/// reported as `None` so callers can distinguish it from an empty server.
pub fn parse_players(response: &str) -> Option<Vec<String>> {
    if !response.contains("Players connected") {
        return None;
    }

    Some(
        response
            .lines()
            .map(str::trim)
            .filter_map(|line| line.strip_prefix('-'))
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_populated_player_list() {
        let response = "Players connected (2):\n-alice\n-bob\n";

        assert_eq!(
            parse_players(response),
            Some(vec!["alice".to_owned(), "bob".to_owned()])
        );
    }

    #[test]
    fn parses_an_empty_server_as_an_empty_list() {
        assert_eq!(parse_players("Players connected (0):"), Some(vec![]));
    }

    #[test]
    fn rejects_a_reply_without_the_header() {
        assert_eq!(parse_players("Unknown command: players"), None);
    }

    #[test]
    fn ignores_blank_and_unprefixed_lines() {
        let response = "Players connected (1):\n\n-  alice  \nnoise\n";

        assert_eq!(parse_players(response), Some(vec!["alice".to_owned()]));
    }
}
