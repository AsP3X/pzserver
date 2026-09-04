//! JSON the Knox Relay codec writes.
//!
//! Lua has one table type. `KR_Codec` treats a table with no keys as `[]`, so
//! a map field that happens to be empty arrives as an array. Serde's `BTreeMap`
//! rejects that. These helpers accept the empty-array form without treating a
//! populated array as a map.

use std::collections::BTreeMap;
use std::fmt;
use std::marker::PhantomData;

use serde::Deserialize;
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};

pub fn btree_map_from_lua<'de, D, V>(deserializer: D) -> Result<BTreeMap<String, V>, D::Error>
where
    D: Deserializer<'de>,
    V: Deserialize<'de>,
{
    struct MapVisitor<V> {
        marker: PhantomData<V>,
    }

    impl<'de, V> Visitor<'de> for MapVisitor<V>
    where
        V: Deserialize<'de>,
    {
        type Value = BTreeMap<String, V>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("a map or an empty array")
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(BTreeMap::new())
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(BTreeMap::new())
        }

        fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            if seq.next_element::<IgnoredAny>()?.is_some() {
                return Err(de::Error::custom("expected a map, got a non-empty array"));
            }
            Ok(BTreeMap::new())
        }

        fn visit_map<M>(self, mut access: M) -> Result<Self::Value, M::Error>
        where
            M: MapAccess<'de>,
        {
            let mut map = BTreeMap::new();
            while let Some((key, value)) = access.next_entry()? {
                map.insert(key, value);
            }
            Ok(map)
        }
    }

    deserializer.deserialize_any(MapVisitor {
        marker: PhantomData,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Wrap {
        #[serde(default, deserialize_with = "btree_map_from_lua")]
        players: BTreeMap<String, i32>,
    }

    #[test]
    fn an_empty_array_is_an_empty_map() {
        let wrap: Wrap = serde_json::from_str(r#"{"players":[]}"#).expect("parse");
        assert!(wrap.players.is_empty());
    }

    #[test]
    fn an_object_is_a_map() {
        let wrap: Wrap = serde_json::from_str(r#"{"players":{"rook":1}}"#).expect("parse");
        assert_eq!(wrap.players["rook"], 1);
    }

    #[test]
    fn a_missing_field_is_empty() {
        let wrap: Wrap = serde_json::from_str(r#"{}"#).expect("parse");
        assert!(wrap.players.is_empty());
    }

    #[test]
    fn a_null_field_is_empty() {
        let wrap: Wrap = serde_json::from_str(r#"{"players":null}"#).expect("parse");
        assert!(wrap.players.is_empty());
    }

    #[test]
    fn a_non_empty_array_is_rejected() {
        assert!(serde_json::from_str::<Wrap>(r#"{"players":[1]}"#).is_err());
    }
}
