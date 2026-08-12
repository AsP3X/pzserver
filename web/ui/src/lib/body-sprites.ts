/**
 * The game's own health-panel silhouette, one alpha mask per body part.
 *
 * GENERATED — do not edit by hand. Rebuilt with scripts/extract-body-sprites.py
 * from media/texturepacks/UI2.pack in a Project Zomboid client install, where
 * the art ships as bps_male_<part>; the dedicated server carries none of it.
 *
 * Artwork is The Indie Stone's, used here to draw the same body the player
 * already reads in game. Masks only: every pixel is white, so the colour comes
 * from our own palette and none of the original shading survives.
 *
 * Coordinates are in the source canvas below; the component scales them.
 *
 * Copied unchanged from the PHP stack's UI — it is generated data, not code,
 * and regenerating it would need a client install to hand.
 */
export const BODY_CANVAS = { width: 123, height: 302 };

export type BodySprite = {
    x: number;
    y: number;
    w: number;
    h: number;
    /** Centroid of the visible pixels, so a reading never lands in an L-shaped notch. */
    label: [number, number];
    /** Top-centre of the shape, where a wound pin hangs. */
    pin: [number, number];
    mask: string;
};

/** Head down, so the figure reads the way a person does. */
export const BODY_SPRITES: Record<string, BodySprite> = {
    Head: {
        x: 50, y: 10, w: 26, h: 35,
        label: [62.5, 27.1], pin: [62.5, 12],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABoAAAAjCAQAAAAgNtIgAAAAWklEQVR42u2VwQoAIAhD3f7/n+0WJUGzoEO4m7hHZKlwmxTCLowBJSRkKCEhSxGZHJSRwcUE0p20AxX0HIJ7FeJfCPkPwTjT9sjVnZA5px73tt1N3htYQfImbC28EjoIb0atAAAAAElFTkSuQmCC',
    },
    Neck: {
        x: 51, y: 43, w: 24, h: 15,
        label: [62.5, 50.7], pin: [62.5, 45],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAPCAQAAABUrcdQAAAAT0lEQVR42s2SMQ7AMAgDzxH//7K7JGo6EEGneEJwFh4sA4ARZ00itgWpye8Y2SHToKlrDS6x/v3BZdowGjiA25FkGqG0DBWT9g/nNn0q+QAGixITt1QAxwAAAABJRU5ErkJggg==',
    },
    Torso_Upper: {
        x: 39, y: 58, w: 48, h: 49,
        label: [62.5, 78.4], pin: [62.5, 60],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAxCAQAAAA2V+KpAAAArUlEQVR42u2Xyw6FMAhEh4n//8u40NxrY0tf4Aq2lHNS0cQRhVmdNgBAzKbuoAc0dcEs3JC8BavwhqQU7MIrEgbgCxID8AWNIfgHkUH4H5Vh+FvBQDwAKBFcKUhBClKQghSkYFAgoXzJHXTrWA4Xgz9sVz7Q1QTWnz020M9TOvuIZl9eaUnogjem6IZvTNIRX52mA9SUff4li2dGfgvEO4b/BRKzgfIG4g3/ZMknYZYcZYzwNWYAAAAASUVORK5CYII=',
    },
    Torso_Lower: {
        x: 41, y: 93, w: 44, h: 54,
        label: [62.5, 120.4], pin: [62.5, 95],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAA2CAQAAAAWwLN3AAAAnklEQVR42u3YQQ6AIAxEUcr97/xdGY0WARlINGVNH1DYMEZqGNdJVi8xesDUvkAJbjrIE+/BPWgRzxLWqcoS1qnMIvZWndOksQRmWMODkWyUZa1AJvKHVxFwwAEHHPBvYaQm320FcpV4bmtgprhEj0+wTXFtaiv0e7a9x6Zmj8szLXv9/aNB/ViBcbQchDCaVjxHN7xNV+qZUHmB6mVvptskUcMhnRYAAAAASUVORK5CYII=',
    },
    Groin: {
        x: 49, y: 145, w: 28, h: 33,
        label: [62.5, 160.8], pin: [62.5, 147],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAhCAQAAABg4ANsAAAAa0lEQVR42u2VSwoAMQhDE/H+V87sBqYotaVQhHEZ8oKfhRQAAAJAzOv1+SAiCdAoeMUUldWt32DDZt0BtUyp2Yza4tTsjj+Ygtzi2Gw561Py3h252uiBVpklZ6pNbGmYD6IqUPStGD6hoJsHOCYOTsFFRcgAAAAASUVORK5CYII=',
    },
    UpperArm_R: {
        x: 26, y: 53, w: 32, h: 63,
        label: [34.2, 83.1], pin: [50.0, 55],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAA/CAQAAAAr8wIxAAAAk0lEQVR42u2V4Q6AIAiEPeb7v/L1KyvbEHAr3eCf1X1woAkWZ7DgvqxO8SvAmLhVIcHcPJ9YKlA/qWExdICWdTAF3RN0C05xD6BX/BxjSH4BgnLLRoL+WmzTjlaA8TYVJT8sh0TKZKwA4P4WEpCABKwP4C4WkGPMe2FxALIHvwOwi4XaFcwIAJ1zzv5UMd8DfNjEA5LgGIozX5N0AAAAAElFTkSuQmCC',
    },
    UpperArm_L: {
        x: 68, y: 53, w: 32, h: 63,
        label: [90.8, 83.1], pin: [75.0, 55],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAA/CAQAAAAr8wIxAAAAl0lEQVR42u2V2w6AIAxD18X//+X6ZIIhug6iQbM9ES6HrsAA7RQ0WCq866ExAwDbpaeRnIJ+X6oK7idCT4FjEFAXDgUQZ48YkIL45ZS7zBkDIvOoACSER8ecfws6ghogUOHahb/W4DYZ3wewPChAAQqQA/DPHqDuQf0LLwJQHiwBwLopbCNlrK3V2+Dio52sB5grqnjExB2xXh13KflNkgAAAABJRU5ErkJggg==',
    },
    ForeArm_R: {
        x: 19, y: 111, w: 19, h: 47,
        label: [28.6, 131.8], pin: [30.5, 113],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAvCAQAAACr4TmRAAAAcElEQVR42u2UwQ6AMAhD+/j/f64no1nYnFOnBzmSl5aSAFZSa5O1gWuI9mgUiHPl0HG5D1Mv5mgMf1rtMcxvmP6YJDHflA3ztxbCfFPmJ2VIzVdMuTECJeZxNQbX667TcvbfqM9GbwTqaLQTtpIm6AKSjhFbzaxuTAAAAABJRU5ErkJggg==',
    },
    ForeArm_L: {
        x: 88, y: 111, w: 19, h: 47,
        label: [96.4, 131.8], pin: [94.5, 113],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAvCAQAAACr4TmRAAAAcklEQVR42tWUUQ7AIAhDKdn9r9x9aeIgaOYGW7+MeSkFjKB0tSPECBwR8VF1IRGOd+pCRipL0hWv2I03iuZh/HC2n2CoyYZ9N743N9QsCzUvBClFecXwcFHsuNFiSNgCwfDPbSFit570mCORG+YtOEM5AU3nEVxFhpQIAAAAAElFTkSuQmCC',
    },
    Hand_R: {
        x: 6, y: 153, w: 22, h: 28,
        label: [17.6, 166.0], pin: [20.0, 155],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAcCAQAAADPJofWAAAAcUlEQVR42sXSSw6AIAwE0JnG+1+5Logg5TdGiV2R8jJpKHQMqlwwH3zGAjeBAp66JtB8YyJtxlhQuMn0lizQC0s0YZGCVlGWbfXqCFvyOSbk0pfC3t+Qkz/CfPo3dozBV8n+w9NxUzJ7mCtaJ7OBoXMCi2QVN/bgHLQAAAAASUVORK5CYII=',
    },
    Hand_L: {
        x: 98, y: 153, w: 22, h: 28,
        label: [107.4, 166.0], pin: [105.0, 155],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAcCAQAAADPJofWAAAAdElEQVR42rWSSw7AIAhEGdL7X3m6MX4CKLbKSpPHcwiCUqsdIW6BFg1btIB0RPRgSlT0zJLDdeI1+Mo84Bm44jm44BotwMPnZgwq6vLxruFJRUAbEPmlbNQHGKfM/JkZlwY8+kUNjIuZsWfG7M/ZGDAN3f0F9zwVNoE4OVQAAAAASUVORK5CYII=',
    },
    UpperLeg_R: {
        x: 36, y: 135, w: 26, h: 90,
        label: [47.0, 184.1], pin: [40.0, 137],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABoAAABaCAQAAAAMG44pAAAAq0lEQVR42u2XwQrDIBBEfUv+/5enhzYNpMToNKlLccFL4DGzo24QlVepUBorilHx1nmu+5VWPXlK8uyd6h31VAWjYkleevIi10371AHVAma8vYshxtvTtUpkj3xCPqS/DELZe/rlWJanJM/e7r+4NDeibdgsnRnoi/SYM2JCwyDS2mPukw2xQsz0oj+7DSJ7T6SyxydE9hNBEntkvhocQ3hKnD/1ouktuPvyACHPGrWzb6ohAAAAAElFTkSuQmCC',
    },
    UpperLeg_L: {
        x: 64, y: 135, w: 26, h: 90,
        label: [78.0, 184.1], pin: [85.0, 137],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABoAAABaCAQAAAAMG44pAAAApUlEQVR42u2XwQ6EIBBDeWT//5e7B6+CdBbW0UBiYkzqK3UcAJXhocJxU0tgVINzXFHSZ5hi2pNLkmtPfnpqP60upS3SrI+7RkQ/07vtBUXkttet/LaIp85pi6Ld6MlzUmZ7/2rL8kVyF2p5q7uKtSVQ4tpjN5YtukVEmMRO7ycRq0m8O3JWksgcBFNIrLFH5jJiIons/xNzSfREjB306uVJ8ORFXzPlFsAVmKw+AAAAAElFTkSuQmCC',
    },
    LowerLeg_R: {
        x: 41, y: 222, w: 18, h: 66,
        label: [49.8, 252.1], pin: [43.5, 224],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAABCCAQAAADwSU4rAAAAdklEQVR42u1VWwqAMAxLxu5/5fihKBt7ia5WNF+jC20JyUYBgAAQVYT9pMKt1mpISjllA1XrcoABA7iXJLNxGuwkawl+0sdJ9rmjS514vRNP7USXVuH0cXw0CHxNOGW9k3pf/jQJ5CgIsWzYVKfYJGRvAVu2WwBS5xGFNu1VHgAAAABJRU5ErkJggg==',
    },
    LowerLeg_L: {
        x: 67, y: 222, w: 18, h: 66,
        label: [75.2, 252.1], pin: [81.5, 224],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAABCCAQAAADwSU4rAAAAcElEQVR42u1UQQrAIAxLxP9/Obs4dKijMqgV1lskTUJbpPBSAkAgFaAJBcBNejz1ODdw6pxgKE+SzEpyDK5wc/pJcUk8MjjDZSrfIV3sGG4tXFbiMUfHrZnkaacvSvKek7asJQ/PV70SB5dEmx1r+wVjnhGGRfBQlwAAAABJRU5ErkJggg==',
    },
    Foot_R: {
        x: 41, y: 285, w: 18, h: 14,
        label: [50.4, 292.1], pin: [52.5, 287],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAAOCAQAAACI04Q8AAAAPklEQVR42q3OOwoAMAwCUO3972yXQqmB2CGO8vKhYPGCwDJQZqAXVXD6FQnupob4Ty3SD8IQUkYaPJfCjAhsE3EME2BvdW0AAAAASUVORK5CYII=',
    },
    Foot_L: {
        x: 67, y: 285, w: 18, h: 14,
        label: [74.6, 292.1], pin: [72.5, 287],
        mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAAOCAQAAACI04Q8AAAAP0lEQVR42q3OMQoAMAhD0a/3v3M6tSCIZqhb5BENAYg6UWM2BFR32ZALSxMbm9BjM8JD+tZkInlNMs+F99PKDsACDBN8NFCyAAAAAElFTkSuQmCC',
    },
};

export const BODY_PART_ORDER: string[] = [
    'Head',
    'Neck',
    'Torso_Upper',
    'Torso_Lower',
    'Groin',
    'UpperArm_R',
    'UpperArm_L',
    'ForeArm_R',
    'ForeArm_L',
    'Hand_R',
    'Hand_L',
    'UpperLeg_R',
    'UpperLeg_L',
    'LowerLeg_R',
    'LowerLeg_L',
    'Foot_R',
    'Foot_L',
];
