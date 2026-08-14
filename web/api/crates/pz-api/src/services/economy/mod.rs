//! Player economy: one wallet, two markets, one item pipe.
//!
//! - [`wallet`] is the only place coins move. Daily rewards, quests and levels
//!   should credit here with their own `source` string — no schema change.
//! - [`store`] is the staff catalogue. Fixed prices, optional stock.
//! - [`auction`] is player-to-player: list, bid, buyout.
//! - [`delivery`] gives and takes items through RCON or the Knox Relay queue.
//!
//! [`rewards`] pays the daily drop, tasks and rank-ups through `wallet`.

pub mod auction;
pub mod delivery;
pub mod inventory;
pub mod objectives;
pub mod quests;
pub mod rewards;
pub mod store;
pub mod vault;
pub mod wallet;

pub const SOURCE_ADMIN: &str = "admin";
pub const SOURCE_STORE: &str = "store";
pub const SOURCE_STORE_REFUND: &str = "store_refund";
pub const SOURCE_AUCTION_ESCROW: &str = "auction_escrow";
pub const SOURCE_AUCTION_REFUND: &str = "auction_refund";
pub const SOURCE_AUCTION_SALE: &str = "auction_sale";
pub const SOURCE_DAILY_REWARD: &str = "daily_reward";
pub const SOURCE_QUEST: &str = "quest";
pub const SOURCE_LEVEL: &str = "level";

const MAX_COINS: i64 = 10_000_000;

pub fn item_type(raw: &str) -> Result<&str, crate::error::ApiError> {
    let value = raw.trim();
    if value.len() < 3
        || value.len() > 80
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_')
        || !value.contains('.')
    {
        return Err(crate::error::ApiError::Validation(
            "Item type must look like Base.Axe.".to_owned(),
        ));
    }
    Ok(value)
}

pub fn coins(amount: i64, label: &str) -> Result<i64, crate::error::ApiError> {
    if amount < 1 || amount > MAX_COINS {
        return Err(crate::error::ApiError::Validation(format!(
            "{label} must be between 1 and {MAX_COINS} coins."
        )));
    }
    Ok(amount)
}
