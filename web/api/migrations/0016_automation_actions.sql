-- Extra automation actions: access, rollback, cycle, named world events.

ALTER TABLE automations DROP CONSTRAINT automations_action_check;

ALTER TABLE automations ADD CONSTRAINT automations_action_check
    CHECK (action IN (
        'restart',
        'start',
        'stop',
        'save',
        'backup',
        'broadcast',
        'rcon',
        'whitelist_open',
        'whitelist_close',
        'config',
        'kick_all',
        'rollback',
        'cycle',
        'chopper',
        'gunshot',
        'rain_start',
        'rain_stop',
        'thunder'
    ));
