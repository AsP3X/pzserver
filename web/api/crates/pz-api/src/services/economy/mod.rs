//! Player economy: one wallet, two markets, one item pipe.
//!
//! - [`wallet`] is the only place coins move. Daily rewards, quests and levels
//!   should credit here with their own `source` string — no schema change.
//! - [`deposit`] is the way in from the game: cash off a character becomes
//!   coins, items-first through the Knox Relay queue.
//! - [`store`] is the staff catalogue. Fixed prices, optional stock.
//! - [`auction`] is player-to-player: list, bid, buyout.
//! - [`offers`] is the other side of that: post a price, fill it with the item.
//! - [`delivery`] gives and takes items through the Knox Relay queue.
//!
//! [`rewards`] pays the daily drop, tasks and rank-ups through `wallet`.

pub mod auction;
pub mod delivery;
pub mod deposit;
pub mod inventory;
pub mod measure;
pub mod notices;
pub mod offers;
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
pub const SOURCE_OFFER_ESCROW: &str = "offer_escrow";
pub const SOURCE_OFFER_REFUND: &str = "offer_refund";
pub const SOURCE_OFFER_SALE: &str = "offer_sale";
pub const SOURCE_DAILY_REWARD: &str = "daily_reward";
pub const SOURCE_DEPOSIT: &str = "deposit";
pub const SOURCE_QUEST: &str = "quest";
pub const SOURCE_LEVEL: &str = "level";

/// Every string a wallet row is allowed to carry. The website labels these
/// in the ledger; a typo at the call site must fail rather than land as an
/// untranslated source.
pub const WALLET_SOURCES: &[&str] = &[
    SOURCE_ADMIN,
    SOURCE_STORE,
    SOURCE_STORE_REFUND,
    SOURCE_AUCTION_ESCROW,
    SOURCE_AUCTION_REFUND,
    SOURCE_AUCTION_SALE,
    SOURCE_OFFER_ESCROW,
    SOURCE_OFFER_REFUND,
    SOURCE_OFFER_SALE,
    SOURCE_DAILY_REWARD,
    SOURCE_DEPOSIT,
    SOURCE_QUEST,
    SOURCE_LEVEL,
    vault::SOURCE_FEE,
    vault::SOURCE_UPGRADE,
];

pub fn wallet_source(source: &str) -> Result<&str, crate::error::ApiError> {
    if WALLET_SOURCES.contains(&source) {
        Ok(source)
    } else {
        Err(crate::error::ApiError::Internal(format!(
            "unknown wallet source {source}"
        )))
    }
}

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
    if !(1..=MAX_COINS).contains(&amount) {
        return Err(crate::error::ApiError::Validation(format!(
            "{label} must be between 1 and {MAX_COINS} coins."
        )));
    }
    Ok(amount)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_declared_source_is_on_the_allowlist() {
        for source in [
            SOURCE_ADMIN,
            SOURCE_STORE,
            SOURCE_STORE_REFUND,
            SOURCE_AUCTION_ESCROW,
            SOURCE_AUCTION_REFUND,
            SOURCE_AUCTION_SALE,
            SOURCE_OFFER_ESCROW,
            SOURCE_OFFER_REFUND,
            SOURCE_OFFER_SALE,
            SOURCE_DAILY_REWARD,
            SOURCE_DEPOSIT,
            SOURCE_QUEST,
            SOURCE_LEVEL,
            vault::SOURCE_FEE,
            vault::SOURCE_UPGRADE,
        ] {
            assert_eq!(wallet_source(source).expect(source), source);
        }
    }

    #[test]
    fn an_unknown_source_is_rejected() {
        assert!(wallet_source("typo").is_err());
    }
}
